import { MODEL_TIMEOUT_MS } from '../config';
import type { ChatMessage } from '../types';

/**
 * OpenAI 兼容 chat completions 调用。
 */

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | null;
		};
	}>;
}

/**
 * 调用一次 chat completions，返回模型输出的文本。
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
	timeoutMs?: number;
}): Promise<string> {
	const { baseUrl, apiKey, model, messages, jsonOutput, allowEmpty, timeoutMs } = opts;
	const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

	const attempt = async (withResponseFormat: boolean): Promise<string> => {
		const body: Record<string, unknown> = { model, messages };
		if (withResponseFormat) {
			body.response_format = { type: 'json_object' };
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs ?? MODEL_TIMEOUT_MS);

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

			const data = (await res.json()) as ChatCompletionResponse;
			const content = data.choices?.[0]?.message?.content;
			if (typeof content !== 'string' || (!allowEmpty && !content.trim())) {
				throw new Error(`chat/completions returned empty content (model=${model})`);
			}
			return content;
		} finally {
			clearTimeout(timer);
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
