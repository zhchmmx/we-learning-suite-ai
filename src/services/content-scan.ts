/**
 * Waffo Pancake scan-prompt 内容审核
 *
 * 管线两个接入点：
 * - 输入侧（scanCorpus）：语料组装完成后、规划模型调用前，分块扫描用户上传内容；
 * - 输出侧（scanQuestionBatch）：每批题目通过 validateQuestions 后、进入 allQuestions 前，
 *   整批 → 逐题 → 单题分块降级扫描。
 *
 * 总原则 fail-closed：没有拿到 allow 就不继续生成 / 入库。
 * 失败信号统一抛 ContentScanError(reasonCode)，由 DO 的 handleTaskError 映射到会话失败原因码。
 * 审计：每次扫描输出结构化 [scan] 日志（含 requestId，按 session 检索用于申诉）。
 */

import type { GeneratedQuestion } from '../types';

/** 会话失败原因码（与 API Worker 的 FAIL_REASONS 白名单一致） */
export type ScanReasonCode = 'CONTENT_BLOCKED' | 'CONTENT_REVIEW_PENDING' | 'CONTENT_SCAN_UNAVAILABLE';

/** 审核失败：reasonCode 决定会话以什么原因失败 */
export class ContentScanError extends Error {
	constructor(
		public readonly reasonCode: ScanReasonCode,
		message: string,
	) {
		super(message);
		this.name = 'ContentScanError';
	}
}

/** 扫描服务返回非 2xx / 响应不可解析（内部错误类型，不外抛） */
class ScanHttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly bodySnippet: string,
	) {
		super(`Scan service HTTP ${status}: ${bodySnippet}`);
		this.name = 'ScanHttpError';
	}
}

interface ScanVerdict {
	action: 'allow' | 'review' | 'block';
	reasonCode: string;
	matchedCategories: string[];
	requestId: string;
}

interface ScanContext {
	sessionId: string;
	stage: 'input' | 'output';
	index: number;
}

const SCAN_PATH = '/v1/actions/verification/scan-prompt';

/** review（含 service_degraded）重扫等待：初次 + 3 次重试 */
const REVIEW_RETRY_WAITS_MS = [5_000, 15_000, 45_000];
/** 5xx / 网络错误 / 超时退避：初次 + 3 次重试 */
const SERVER_RETRY_WAITS_MS = [5_000, 10_000, 20_000];

/** 分块边界优先级（在窗口内取最靠后的位置） */
const CHUNK_SEPARATORS = ['\n\n', '\n', '。', '？', '！', '；', '…', '. ', '? ', '! ', '; ', ' '];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function intVar(value: string | undefined, fallback: number): number {
	const n = Number.parseInt(value ?? '', 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 按段落/句子边界分块，每块 ≤ maxChars。
 * 优先在窗口后半段找分隔符；找不到合理边界（位置 < 窗口一半）则硬切。
 */
export function chunkText(text: string, maxChars: number): string[] {
	if (maxChars < 1) throw new Error('maxChars must be >= 1');
	if (text.length <= maxChars) return text ? [text] : [];

	const chunks: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		// 候选切点 = 分隔符末尾位置（分隔符整体归属前一块），取最靠后的
		let cut = -1;
		for (const sep of CHUNK_SEPARATORS) {
			const idx = window.lastIndexOf(sep);
			if (idx >= 0 && idx + sep.length > cut) cut = idx + sep.length;
		}
		if (cut < maxChars / 2) cut = maxChars; // 无合理边界 → 硬切
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	chunks.push(rest);
	return chunks;
}

/** 有界并发 map（简易 Promise 池） */
async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	const workers: Promise<void>[] = [];
	for (let w = 0; w < workerCount; w++) {
		workers.push(
			(async () => {
				for (;;) {
					const i = next++;
					if (i >= items.length) return;
					results[i] = await fn(items[i], i);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return results;
}

// ===== 签名 =====

let cachedKeyPromise: Promise<CryptoKey> | null = null;

/** 裸 Base64（可带 PEM 头尾，防御性剥离）→ DER 字节 */
function decodePrivateKey(raw: string): ArrayBuffer {
	const cleaned = raw
		.replace(/-----BEGIN [^-]+-----/g, '')
		.replace(/-----END [^-]+-----/g, '')
		.replace(/\s+/g, '');
	const binary = atob(cleaned);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

function getSigningKey(env: Env): Promise<CryptoKey> {
	if (!cachedKeyPromise) {
		cachedKeyPromise = crypto.subtle
			.importKey(
				'pkcs8',
				decodePrivateKey(env.WAFFO_PRIVATE_KEY),
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
				false,
				['sign'],
			)
			.catch((err) => {
				cachedKeyPromise = null; // 导入失败不缓存，下次调用重试（并再次暴露错误）
				throw err;
			});
	}
	return cachedKeyPromise;
}

function bytesToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

/**
 * 签名规则（与官方 cURL 示例一致）：
 * bodyHash = base64(sha256(body))；canonical = "POST\n{path}\n{秒级时间戳}\n{bodyHash}"；
 * signature = base64(RSA-SHA256(canonical))。
 * 注意：先序列化再签名，body 字符串与 fetch 请求体必须是同一份，保证字节一致。
 */
async function signRequest(env: Env, body: string): Promise<{ timestamp: string; signature: string }> {
	const bodyHash = bytesToBase64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const canonical = `POST\n${SCAN_PATH}\n${timestamp}\n${bodyHash}`;
	const key = await getSigningKey(env);
	const signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(canonical));
	return { timestamp, signature: bytesToBase64(signatureBuffer) };
}

// ===== 单次请求与重试 =====

/** 单次扫描请求（不含重试）：成功返回 verdict，非 2xx / 不可解析抛 ScanHttpError */
async function scanOnce(env: Env, text: string): Promise<ScanVerdict> {
	const base = (env.WAFFO_SCAN_BASE_URL || 'https://api.waffo.ai').replace(/\/+$/, '');
	const body = JSON.stringify({ prompt: text });
	const { timestamp, signature } = await signRequest(env, body);

	const res = await fetch(`${base}${SCAN_PATH}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Merchant-Id': env.WAFFO_MERCHANT_ID,
			'X-Timestamp': timestamp,
			'X-Signature': signature,
		},
		body,
		signal: AbortSignal.timeout(intVar(env.SCAN_TIMEOUT_MS, 15_000)),
	});

	const resText = await res.text();
	if (!res.ok) {
		throw new ScanHttpError(res.status, resText.slice(0, 300));
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(resText);
	} catch {
		throw new ScanHttpError(res.status, `Unparseable response: ${resText.slice(0, 200)}`);
	}

	// 响应字段在 data 内层；兼容直接平铺的情况
	const outer = parsed as Record<string, unknown>;
	const data = (outer && typeof outer.data === 'object' && outer.data !== null ? outer.data : outer) as Record<string, unknown>;

	const action = data.action;
	if (action !== 'allow' && action !== 'review' && action !== 'block') {
		throw new ScanHttpError(res.status, `Unknown scan action: ${String(action)}`);
	}

	return {
		action,
		reasonCode: typeof data.reasonCode === 'string' ? data.reasonCode : '',
		matchedCategories: Array.isArray(data.matchedCategories) ? (data.matchedCategories as unknown[]).map(String) : [],
		requestId: typeof data.requestId === 'string' ? data.requestId : '',
	};
}

function logScan(ctx: ScanContext, verdict: ScanVerdict): void {
	console.log(
		`[scan] session=${ctx.sessionId} stage=${ctx.stage} index=${ctx.index} action=${verdict.action} reasonCode=${verdict.reasonCode} categories=${JSON.stringify(verdict.matchedCategories)} requestId=${verdict.requestId}`,
	);
}

/**
 * 带重试的单次扫描：
 * - 4xx：不重试（400「exceeds 10000」= 分块 bug，console.error 告警；其余 = 配置问题），
 *   fail-closed 归为 CONTENT_SCAN_UNAVAILABLE；
 * - 5xx / 网络错误 / 超时：退避 5s/10s/20s 重试 3 次，仍失败 → CONTENT_SCAN_UNAVAILABLE；
 * - 200 且 review（含 service_degraded）：等 5s/15s/45s 重扫 3 次，仍 review → CONTENT_REVIEW_PENDING。
 */
async function scanWithRetry(env: Env, text: string, ctx: ScanContext): Promise<ScanVerdict> {
	let reviewRetries = 0;
	for (;;) {
		const verdict = await fetchWithServerRetries(env, text, ctx);
		if (verdict.action !== 'review') {
			logScan(ctx, verdict);
			return verdict;
		}
		logScan(ctx, verdict);
		if (reviewRetries >= REVIEW_RETRY_WAITS_MS.length) {
			throw new ContentScanError(
				'CONTENT_REVIEW_PENDING',
				`Content scan still pending review after ${reviewRetries} retries (${ctx.stage}#${ctx.index}, requestId=${verdict.requestId})`,
			);
		}
		await sleep(REVIEW_RETRY_WAITS_MS[reviewRetries]);
		reviewRetries++;
	}
}

async function fetchWithServerRetries(env: Env, text: string, ctx: ScanContext): Promise<ScanVerdict> {
	let lastError: unknown;
	for (let attempt = 0; ; attempt++) {
		try {
			return await scanOnce(env, text);
		} catch (err) {
			if (err instanceof ScanHttpError && err.status >= 400 && err.status < 500) {
				if (err.status === 400 && /10000/i.test(err.bodySnippet)) {
					console.error(
						`[scan] prompt exceeds 10000 chars — chunking bug! session=${ctx.sessionId} stage=${ctx.stage} index=${ctx.index}: ${err.bodySnippet}`,
					);
				} else {
					console.error(`[scan] 4xx from scan service (config issue?) session=${ctx.sessionId}: ${err.message}`);
				}
				throw new ContentScanError('CONTENT_SCAN_UNAVAILABLE', `Content scan rejected request (HTTP ${err.status})`);
			}
			lastError = err;
			if (attempt >= SERVER_RETRY_WAITS_MS.length) break;
			console.warn(`[scan] transient failure (attempt ${attempt + 1}), retrying in ${SERVER_RETRY_WAITS_MS[attempt]}ms:`, err);
			await sleep(SERVER_RETRY_WAITS_MS[attempt]);
		}
	}
	console.error(`[scan] service unreachable after retries, session=${ctx.sessionId}:`, lastError);
	throw new ContentScanError('CONTENT_SCAN_UNAVAILABLE', 'Content scan service unreachable');
}

/** 扫描一段文本：allow 静默通过，block 抛 CONTENT_BLOCKED，其余失败由 scanWithRetry 抛出 */
async function scanText(env: Env, text: string, ctx: ScanContext): Promise<void> {
	const verdict = await scanWithRetry(env, text, ctx);
	if (verdict.action === 'block') {
		throw new ContentScanError(
			'CONTENT_BLOCKED',
			`Content scan blocked ${ctx.stage}#${ctx.index} (requestId=${verdict.requestId})`,
		);
	}
}

// ===== 对外入口 =====

/**
 * 输入侧：语料分块 + 有界并发扫描。
 * CONTENT_SCAN_ENABLED !== 'true' 时直接跳过（回滚通道）。
 * 任一块 block / review 未决 / 服务不可用 → 抛 ContentScanError。
 */
export async function scanCorpus(env: Env, corpus: string, sessionId: string): Promise<void> {
	if (env.CONTENT_SCAN_ENABLED !== 'true') return;
	const maxChars = intVar(env.SCAN_MAX_CHARS, 9000);
	const chunks = chunkText(corpus, maxChars);
	console.log(`[scan] session=${sessionId} stage=input chunks=${chunks.length} corpusChars=${corpus.length}`);
	await mapWithConcurrency(chunks, intVar(env.SCAN_CONCURRENCY, 4), (chunk, i) =>
		scanText(env, chunk, { sessionId, stage: 'input', index: i }),
	);
}

/**
 * 输出侧：整批 JSON 一次扫；超限时降级逐题（有界并发）；单题仍超限则对该题 JSON 分块。
 * CONTENT_SCAN_ENABLED !== 'true' 时直接跳过。
 */
export async function scanQuestionBatch(
	env: Env,
	questions: GeneratedQuestion[],
	sessionId: string,
	batchIndex: number,
): Promise<void> {
	if (env.CONTENT_SCAN_ENABLED !== 'true') return;
	if (questions.length === 0) return;

	const maxChars = intVar(env.SCAN_MAX_CHARS, 9000);
	const whole = JSON.stringify({ questions });
	if (whole.length <= maxChars) {
		await scanText(env, whole, { sessionId, stage: 'output', index: batchIndex });
		return;
	}

	console.log(
		`[scan] session=${sessionId} stage=output batch=${batchIndex} wholeJsonChars=${whole.length} > ${maxChars}, falling back to per-question scan`,
	);
	await mapWithConcurrency(questions, intVar(env.SCAN_CONCURRENCY, 4), async (q, i) => {
		const single = JSON.stringify(q);
		const parts = single.length <= maxChars ? [single] : chunkText(single, maxChars);
		for (const part of parts) {
			// 逐题降级时 index = 批次号 * 1000 + 题序号，便于日志区分
			await scanText(env, part, { sessionId, stage: 'output', index: batchIndex * 1000 + i });
		}
	});
}
