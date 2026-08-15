import { CHUNK_IDLE_TIMEOUT_MS } from '../config';
import type { ChatMessage } from '../types';

/**
 * AI Gateway 流式调用（Cloudflare 统一 AI 端点 + Gateway 路由）。
 * fetch + SSE 逐 chunk 拼接输出，空闲超时策略不变。
 *
 * 端点：api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions
 * 通过 cf-aig-gateway-id 头路由到 AI Gateway。
 */

/** OpenAI 兼容格式的流式 delta */
interface StreamDelta {
	choices?: Array<{
		delta?: {
			content?: string | null;
		};
	}>;
}

/** 自定义成本（cf-aig-custom-cost 请求头） */
export interface CustomCost {
	perTokenIn: number;
	perTokenOut: number;
}

/**
 * 调用一次 chat completions（流式），返回模型输出的完整文本。
 * 任何错误 / 空输出 / 超时都抛错（由 Gateway 负责 fallback）。
 *
 * @param jsonOutput 请求 JSON 输出模式。若模型不认识 response_format 参数
 *                   （返回 400），自动去掉该参数重试一次再判断失败。
 * @param allowEmpty 允许空输出（OCR 场景：图片里没有文字时模型正常返回空内容，不算失败）
 * @param customCost 自定义成本，通过 cf-aig-custom-cost 头传给 Gateway，
 *                   仅影响仪表盘成本展示，不改变实际计费。
 */
export async function chatCompletion(opts: {
	accountId: string;
	aigToken: string;
	gatewayId: string;
	model: string;
	messages: ChatMessage[];
	customCost: CustomCost;
	jsonOutput?: boolean;
	allowEmpty?: boolean;
	maxTokens?: number;
}): Promise<string> {
	const { accountId, aigToken, gatewayId, model, messages, customCost, jsonOutput, allowEmpty, maxTokens } = opts;
	const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

	if (jsonOutput) {
		try {
			return await doCall(true);
		} catch (err) {
			// 模型不支持 response_format：去掉参数重试一次
			if (isUnsupportedError(err)) {
				return doCall(false);
			}
			throw err;
		}
	}
	return doCall(false);

	/** 执行一次流式调用，拼接并返回完整文本 */
	async function doCall(withResponseFormat: boolean): Promise<string> {
		const body: Record<string, unknown> = { model, messages, stream: true };
		if (withResponseFormat) {
			body.response_format = { type: 'json_object' };
		}
		if (maxTokens) {
			body.max_tokens = maxTokens;
		}

		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${aigToken}`,
				'cf-aig-gateway-id': gatewayId,
				'cf-aig-custom-cost': JSON.stringify({
					per_token_in: customCost.perTokenIn,
					per_token_out: customCost.perTokenOut,
				}),
			},
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const err = new Error(`chat/completions returned ${res.status} (model=${model})`);
			(err as Error & { status?: number }).status = res.status;
			throw err;
		}

		if (!res.body) {
			throw new Error(`chat/completions returned no body (model=${model})`);
		}

		// 流式读取 SSE
		const reader = res.body.getReader();
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
							const delta = JSON.parse(payload) as StreamDelta;
							const text = delta.choices?.[0]?.delta?.content;
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
			throw new Error(`AI returned empty content (model=${model})`);
		}
		return accumulated;
	}
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
