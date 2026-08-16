import { CHUNK_IDLE_TIMEOUT_MS } from '../config';
import type { ChatMessage, ChatTarget } from '../types';

/**
 * 模型流式调用（经 AI Gateway provider 透传端点，fetch 直连）：
 * gateway.getUrl() 取网关基础 URL，拼 /{provider}/v1/chat/completions，
 * body 放裸模型名；Authorization 头做网关鉴权，上游 BYOK key 由网关注入。
 * dynamic 路由同构：provider='dynamic'、model 为裸路由名（如 plan_auto）。
 *
 * SSE chunk 兼容两种格式：
 * - Workers AI 原生：delta.response
 * - OpenAI 兼容（自定义提供商）：choices[0].delta.content
 */

/** OpenAI 兼容格式的流式 delta */
interface OpenAIStreamDelta {
	choices?: Array<{
		delta?: {
			content?: string | null;
		};
	}>;
}

/** Workers AI 原生格式的流式 delta */
interface NativeStreamDelta {
	response?: string;
}

/**
 * 调用一次 chat completions（流式），返回模型输出的完整文本。
 * 按传入的目标链依次尝试：任一模型失败（错误 / 空输出 / 超时）立即换下一个，
 * 不加退避等待、不重试同一模型（网关侧已配置指数退避）；全链失败抛出聚合错误。
 *
 * @param jsonOutput 请求 JSON 输出模式。若模型不认识 response_format 参数
 *                   （抛错），自动去掉该参数重试一次再判断失败。
 * @param allowEmpty 允许空输出（OCR 场景：图片里没有文字时模型正常返回空内容，不算失败）
 */
export async function chatCompletion(opts: {
	ai: Ai;
	gatewayId: string;
	authToken: string;
	models: ChatTarget[];
	messages: ChatMessage[];
	jsonOutput?: boolean;
	allowEmpty?: boolean;
	maxTokens?: number;
}): Promise<string> {
	const { ai, gatewayId, authToken, models, messages, jsonOutput, allowEmpty, maxTokens } = opts;

	let lastErr: unknown;
	const failures: string[] = [];
	for (const target of models) {
		const name = targetName(target);
		try {
			const text = await callModel(target);
			console.log(`chatCompletion ok (model=${name}, chars=${text.length})`);
			return text;
		} catch (err) {
			lastErr = err;
			failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
			console.warn(`Model ${name} failed: ${describeError(err)}`);
		}
	}
	// 聚合每个模型的失败原因，避免只抛最后一个错误丢掉前面的信息
	throw new Error(`All ${models.length} models in chain failed — ${failures.join(' | ')}`, {
		cause: lastErr,
	});

	/** 单目标调用：含 response_format 不兼容时去参重试一次 */
	async function callModel(target: ChatTarget): Promise<string> {
		if (jsonOutput) {
			try {
				return await doCall(target, true);
			} catch (err) {
				// 模型不支持 response_format：去掉参数重试一次
				if (isUnsupportedError(err)) {
					return doCall(target, false);
				}
				throw err;
			}
		}
		return doCall(target, false);
	}

	/** 执行一次流式调用，拼接并返回完整文本 */
	async function doCall(target: ChatTarget, withResponseFormat: boolean): Promise<string> {
		const input: Record<string, unknown> = { messages, stream: true };
		if (withResponseFormat) {
			input.response_format = { type: 'json_object' };
		}
		if (maxTokens) {
			input.max_tokens = maxTokens;
		}

		const stream = await openStream(target, input);

		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let accumulated = '';
		let buffer = ''; // 跨 chunk 的行缓冲区

		try {
			while (true) {
				const chunk = await readWithIdleTimeout(reader);
				if (chunk === null) break; // 流结束

				buffer += decoder.decode(chunk, { stream: true });

				// 按双换行切分 SSE 事件
				const events = buffer.split('\n\n');
				// 最后一段可能不完整，留到下次
				buffer = events.pop() ?? '';

				for (const event of events) {
					for (const line of event.split('\n')) {
						if (!line.startsWith('data:')) continue;
						const payload = line.slice(5).trim();
						if (payload === '[DONE]') continue;

						try {
							const parsed = JSON.parse(payload);
							// 兼容 Workers AI 原生格式和 OpenAI 兼容格式
							const text =
								(typeof (parsed as NativeStreamDelta).response === 'string'
									? (parsed as NativeStreamDelta).response
									: null)
								?? (parsed as OpenAIStreamDelta).choices?.[0]?.delta?.content
								?? null;
							if (typeof text === 'string') {
								accumulated += text;
							}
						} catch {
							// 忽略无法解析的行
						}
					}
				}
			}
		} finally {
			reader.cancel().catch(() => {});
		}

		if (!allowEmpty && !accumulated.trim()) {
			throw new Error(`AI returned empty content (model=${targetName(target)})`);
		}
		return accumulated;
	}

	/** 打开模型输出流：统一走 provider 透传端点（dynamic 路由同构，provider='dynamic'） */
	async function openStream(target: ChatTarget, input: Record<string, unknown>): Promise<ReadableStream> {
		if (!authToken) {
			throw new Error('CF_AIG_TOKEN is not set — run: npx wrangler secret put CF_AIG_TOKEN');
		}
		let base: string;
		try {
			base = await gatewayBaseUrl(ai, gatewayId);
		} catch (err) {
			throw Object.assign(new Error(`gateway getUrl() failed: ${describeError(err)}`), { cause: err });
		}
		const url = `${base}/${target.provider}/v1/chat/completions`;
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${authToken}`,
				},
				body: JSON.stringify({ model: target.model, ...input }),
			});
		} catch (err) {
			throw Object.assign(
				new Error(`fetch ${url} failed: ${describeError(err)}`),
				{ status: (err as { status?: number })?.status, cause: err },
			);
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw Object.assign(
				new Error(`provider ${target.provider} HTTP ${response.status}: ${detail.slice(0, 500)}`),
				{ status: response.status },
			);
		}
		return response.body as ReadableStream;
	}
}

/** 调用目标的日志显示名（路由模式显示为 dynamic/<路由名>） */
function targetName(target: ChatTarget): string {
	return `${target.provider}/${target.model}`;
}

/** 网关基础 URL 缓存（isolate 存续期内复用；失败时移除以便下次重取） */
const gatewayBaseCache = new Map<string, Promise<string>>();

function gatewayBaseUrl(ai: Ai, gatewayId: string): Promise<string> {
	const cached = gatewayBaseCache.get(gatewayId);
	if (cached) return cached;
	// getUrl() 无参形式：返回 https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/
	const pending = ai
		.gateway(gatewayId)
		.getUrl()
		.then(
			(url) => url.replace(/\/+$/, ''),
			(err: unknown) => {
				gatewayBaseCache.delete(gatewayId);
				throw err;
			},
		);
	gatewayBaseCache.set(gatewayId, pending);
	return pending;
}

/** 错误描述：绑定层错误可能没有 message，回退到 name / 字符串形式并带上 status */
function describeError(err: unknown): string {
	if (!err || typeof err !== 'object') return String(err);
	const e = err as { name?: string; message?: string; status?: number };
	const text = e.message || e.name || 'unknown error';
	return e.status !== undefined ? `${text} (status ${e.status})` : text;
}

/**
 * 带空闲超时的 stream reader.read()。
 * 返回 null 表示流结束（done）；超时则抛错。
 */
async function readWithIdleTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array | null> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new Error(`Stream idle timeout after ${CHUNK_IDLE_TIMEOUT_MS}ms`)),
					CHUNK_IDLE_TIMEOUT_MS,
				);
			}),
		]);
		return result.done ? null : result.value;
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

/**
 * 判断错误是否为"模型不支持 response_format"。
 * Gateway 透传的错误可能带 status 或 message 关键字。
 */
function isUnsupportedError(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as Record<string, unknown>;
	if (e.status === 400) return true;
	const msg = String(e.message ?? '').toLowerCase();
	return msg.includes('response_format') || msg.includes('json_object');
}
