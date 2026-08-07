import type { ProviderConfig } from '../types';

/**
 * 提供商链式路由：按 priority 依次尝试，每家最多重试 MAX_RETRIES 次，
 * 全部失败才抛出最后一个错误。
 */

/** 每个提供商的最大尝试次数 */
const MAX_RETRIES = 3;

/** 重试间隔（毫秒），每次翻倍 */
const RETRY_BASE_DELAY_MS = 1_000;

/** 根据提供商名取对应的 secret：AI_PROVIDER_KEY_<NAME 大写，非法字符转下划线> */
export function getProviderKey(env: unknown, name: string): string | undefined {
	const key = `AI_PROVIDER_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
	return (env as Record<string, string | undefined>)[key];
}

export type ProviderTask<T> = (provider: ProviderConfig, apiKey: string) => Promise<T>;

/**
 * 沿提供商链执行任务。
 * @param filter 可选过滤器（如 OCR 阶段只要配了 ocrModel 的提供商）
 */
export async function walkProviderChain<T>(
	env: unknown,
	providers: ProviderConfig[],
	task: ProviderTask<T>,
	filter?: (provider: ProviderConfig) => boolean,
): Promise<{ result: T; provider: ProviderConfig }> {
	const candidates = providers.filter(filter ?? (() => true));

	let lastError: unknown = null;

	for (const provider of candidates) {
		const apiKey = getProviderKey(env, provider.name);
		if (!apiKey) {
			lastError = new Error(`Provider "${provider.name}" is missing secret AI_PROVIDER_KEY_${provider.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`);
			console.error(lastError);
			continue;
		}

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				const result = await task(provider, apiKey);
				return { result, provider };
			} catch (err) {
				lastError = err;
				console.error(`Provider "${provider.name}" attempt ${attempt}/${MAX_RETRIES} failed:`, err);
				if (attempt < MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
				}
			}
		}
	}

	if (candidates.length === 0) {
		throw new Error('No provider available for this stage (check AI_PROVIDERS config)');
	}
	throw lastError instanceof Error ? lastError : new Error('All providers failed');
}
