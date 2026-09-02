import { API_CALLBACK_TIMEOUT_MS } from '../config';

/**
 * 回调 we-learning-suite-api 的客户端。
 * 所有调用都以 ticket 作为凭证（X-Quiz-Ticket 头）。
 */

/** 调用来源：用于错误分类——4xx 只有来自 status/renew 才是"取消信号"，upload 的 4xx 是业务故障 */
export type ApiCallOrigin = 'status' | 'renew' | 'upload';

/** API 回调错误：携带 HTTP 状态码（4xx/5xx），区别于网络层错误 */
export class ApiClientError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly origin: ApiCallOrigin = 'status',
	) {
		super(message);
		this.name = 'ApiClientError';
	}
}

async function callApi(
	fetcher: Fetcher,
	path: string,
	ticket: string,
	method: string,
	body?: unknown,
	origin: ApiCallOrigin = 'status',
): Promise<unknown> {
	const url = `http://we-learning-suite-api${path}`;
	const res = await fetcher.fetch(url, {
		method,
		headers: {
			'Content-Type': 'application/json',
			'X-Quiz-Ticket': ticket,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(API_CALLBACK_TIMEOUT_MS),
	});

	if (!res.ok) {
		const resBody = await res.text().catch(() => '<unreadable>');
		throw new ApiClientError(`API returned ${res.status} for ${method} ${url}\nResponse body: ${resBody.slice(0, 500)}`, res.status, origin);
	}

	try {
		return await res.json();
	} catch {
		return null;
	}
}

/** 会话失败原因码（与 API Worker 的 FAIL_REASONS 白名单一致） */
export type SessionFailReason = 'CONTENT_BLOCKED' | 'CONTENT_REVIEW_PENDING' | 'CONTENT_SCAN_UNAVAILABLE';

/**
 * 更新 session 状态。
 * ticket 即 session id。
 * reason 仅 status === 'failed' 时可携带（内容审核判定），API 端有白名单校验。
 */
export async function patchSessionStatus(
	fetcher: Fetcher,
	ticket: string,
	status: 'processing' | 'completed' | 'failed',
	reason?: SessionFailReason,
): Promise<void> {
	await callApi(fetcher, `/api/quiz/sessions/${ticket}/status`, ticket, 'PATCH', reason ? { status, reason } : { status }, 'status');
}

/** 细粒度生成进度（随 renew 上报，写 quiz_sessions.progress 列） */
export interface ProgressPayload {
	phase: 'planning' | 'scanning' | 'generating' | 'uploading';
	/** generating / uploading：已生成题数 */
	done?: number;
	/** generating / uploading：计划总题数 */
	total?: number;
}

/**
 * 续期 ticket：将 expires_at 往后推一个 TTL 周期。
 * 在长时生成任务中定期调用，防止上传时 ticket 已过期。
 * 可选携带进度载荷——API 端容错解析，进度数据问题不影响续期本身。
 */
export async function renewTicket(
	fetcher: Fetcher,
	ticket: string,
	progress?: ProgressPayload,
): Promise<void> {
	await callApi(fetcher, `/api/quiz/sessions/${ticket}/renew`, ticket, 'POST',
		progress ? { progress } : undefined, 'renew');
}

/**
 * 上传一个分片的题目（分片循环在 pipeline.runUploadPhase）。
 * - offset：本片第一题在总题目列表中的全局序号——API 用它生成确定性 id，
 *   配合 INSERT OR IGNORE 实现分片幂等（响应丢失重发不产生重复行）。
 * - final：仅最后一片为 true，API 只在该片入库后把 session/quizzes 置 completed。
 */
export async function uploadQuestions(
	fetcher: Fetcher,
	ticket: string,
	questions: Array<{ type: string; content: unknown; answer: unknown; tags?: string[] }>,
	offset: number,
	final: boolean,
): Promise<void> {
	await callApi(fetcher, '/api/quiz/questions/batch', ticket, 'POST',
		{ questions, offset, final }, 'upload');
}
