import { CHUNK_IDLE_TIMEOUT_MS } from '../config';
import type { ChatMessage } from '../types';

/**
 * Workers AI 流式调用（通过 AI Gateway compat 端点 / Unified API）。
 * custom-{slug}/{model} 自定义提供商模型与 dynamic/<route> 路由名只在 compat 端点可用——
 * ai.run(model, input, { gateway }) 仅认 @cf/* 与统一计费的第三方模型，传自定义名会在
 * 绑定层报错（Ai._parseError）。流式返回 SSE，逐 chunk 拼接输出，空闲超时策略不变。
 *
 * SSE chunk 兼容两种格式：
 * - Workers AI 原生：delta.response
 * - OpenAI 兼容（compat 端点 / 自定义提供商）：choices[0].delta.content
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
 * 按传入的模型链依次尝试：任一模型失败（错误 / 空输出 / 超时）立即换下一个，
 * 不加退避等待、不重试同一模型（网关侧已配置指数退避）；全链失败抛出最后一个错误。
 *
 * @param jsonOutput 请求 JSON 输出模式。若模型不认识 response_format 参数
 *                   （抛错），自动去掉该参数重试一次再判断失败。
 * @param allowEmpty 允许空输出（OCR 场景：图片里没有文字时模型正常返回空内容，不算失败）
 */
export async function chatCompletion(opts: {
	ai: Ai;
	gatewayId: string;
	models: string[];
	messages: ChatMessage[];
	jsonOutput?: boolean;
	allowEmpty?: boolean;
	maxTokens?: number;
}): Promise<string> {
	const { ai, gatewayId, models, messages, jsonOutput, allowEmpty, maxTokens } = opts;

	let lastErr: unknown;
	const failures: string[] = [];
	for (const model of models) {
		try {
			const text = await callModel(model);
			console.log(`chatCompletion ok (model=${model}, chars=${text.length})`);
			return text;
		} catch (err) {
			lastErr = err;
			failures.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
			console.warn(`Model ${model} failed:`, err);
		}
	}
	// 聚合每个模型的失败原因，避免只抛最后一个错误丢掉前面的信息
	throw new Error(`All ${models.length} models in chain failed — ${failures.join(' | ')}`, {
		cause: lastErr,
	});

	/** 单模型调用：含 response_format 不兼容时去参重试一次 */
	async function callModel(model: string): Promise<string> {
		if (jsonOutput) {
			try {
				return await doCall(model, true);
			} catch (err) {
				// 模型不支持 response_format：去掉参数重试一次
				if (isUnsupportedError(err)) {
					return doCall(model, false);
				}
				throw err;
			}
		}
		return doCall(model, false);
	}

	/** 执行一次流式调用，拼接并返回完整文本 */
	async function doCall(model: string, withResponseFormat: boolean): Promise<string> {
		const input: Record<string, unknown> = { messages, stream: true };
		if (withResponseFormat) {
			input.response_format = { type: 'json_object' };
		}
		if (maxTokens) {
			input.max_tokens = maxTokens;
		}

		const stream = await compatRun(ai, gatewayId, {
			model,
			...input,
		}) as unknown as ReadableStream;

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
 * 通过 AI Gateway compat 端点（Unified API）发起 chat/completions 调用。
 * 生成的 Ai 类型未声明 gateway().run() 的 compat 形态，用最小本地接口断言。
 */
function compatRun(ai: Ai, gatewayId: string, query: Record<string, unknown>): Promise<unknown> {
	const gateway = (ai as unknown as {
		gateway: (id: string) => {
			run: (opts: {
				provider: 'compat';
				endpoint: string;
				headers: Record<string, string>;
				query: Record<string, unknown>;
			}) => Promise<unknown>;
		};
	}).gateway(gatewayId);

	return gateway.run({
		provider: 'compat',
		endpoint: 'chat/completions',
		headers: {},
		query,
	});
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
