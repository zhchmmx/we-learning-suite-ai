import { CHUNK_IDLE_TIMEOUT_MS } from '../config';
import type { ChatMessage } from '../types';

/**
 * OpenAI 兼容 chat completions 流式调用。
 * 请求 stream: true，通过 SSE 逐 chunk 拼接输出，
 * 超时策略为"空闲超时"——最后一个 chunk 到达后若超过
 * CHUNK_IDLE_TIMEOUT_MS 仍无新 chunk 则中止。
 */

interface StreamDelta {
	choices?: Array<{
		delta?: {
			content?: string | null;
		};
	}>;
}

/**
 * 调用一次 chat completions（流式），返回模型输出的完整文本。
 * 任何非 2xx / 空输出 / 超时都抛错（由上层做提供商切换）。
 *
 * @param jsonOutput 请求 JSON 输出模式。若提供商不认识 response_format 参数
 *                   （返回 400），自动去掉该参数重试一次再判断失败。
 * @param allowEmpty 允许空输出（OCR 场景：图片里没有文字时模型正常返回空内容，不算失败）
 */
export async function chatCompletion(opts: {
	baseUrl: string;
	apiKey: string;
	model: string;
	messages: ChatMessage[];
	jsonOutput?: boolean;
	allowEmpty?: boolean;
	maxTokens?: number;
}): Promise<string> {
	const { baseUrl, apiKey, model, messages, jsonOutput, allowEmpty, maxTokens } = opts;
	const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

	const attempt = async (withResponseFormat: boolean): Promise<string> => {
		const body: Record<string, unknown> = { model, messages, stream: true };
		if (withResponseFormat) {
			body.response_format = { type: 'json_object' };
		}
		if (maxTokens) {
			body.max_tokens = maxTokens;
		}

		const controller = new AbortController();
		// 空闲超时：初始给一个较长的首 chunk 等待时间
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const resetIdleTimer = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => controller.abort(), CHUNK_IDLE_TIMEOUT_MS);
		};
		const clearIdleTimer = () => {
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = null;
			}
		};

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
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

			resetIdleTimer();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// 收到数据，重置空闲计时器
				resetIdleTimer();

				buffer += decoder.decode(value, { stream: true });

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
							const chunk = delta.choices?.[0]?.delta?.content;
							if (typeof chunk === 'string') {
								accumulated += chunk;
							}
						} catch {
							// 忽略无法解析的行（某些提供商会在 SSE 里夹注释行）
						}
					}
				}
			}

			clearIdleTimer();

			if (!allowEmpty && !accumulated.trim()) {
				throw new Error(`chat/completions returned empty content (model=${model})`);
			}
			return accumulated;
		} finally {
			clearIdleTimer();
		}
	};

	if (jsonOutput) {
		try {
			return await attempt(true);
		} catch (err) {
			// 提供商不支持 response_format：去掉参数重试一次
			const status = (err as Error & { status?: number }).status;
			if (status === 400) {
				return attempt(false);
			}
			throw err;
		}
	}

	return attempt(false);
}
