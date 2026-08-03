import type { ProviderConfig } from './types';

/** 图片通道限制 */
export const MAX_IMAGES = 15;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 单张 4MB（base64 编码是 CPU 操作，免费套餐要控制量）

/** 文本通道限制（超过直接判失败，提示用户拆分） */
export const MAX_TEXT_CHARS = 60_000;

/** 出题数量 */
export const DEFAULT_QUESTION_COUNT = 5;
export const MIN_QUESTION_COUNT = 1;
export const MAX_QUESTION_COUNT = 50;

/** 每次 OCR 请求最多携带的图片数 */
export const OCR_IMAGES_PER_CALL = 5;

/** 模型调用超时（出题是长任务，给足时间） */
export const MODEL_TIMEOUT_MS = 120_000;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const API_CALLBACK_TIMEOUT_MS = 15_000;

/** 受理端点校验 body 时 downloadUrls 的上限条数 */
export const MAX_DOWNLOAD_URLS = 50;

/** 支持的 MIME 类型 → 通道 */
export const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
export const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * 解析 AI_PROVIDERS JSON 配置。
 * 非法条目静默丢弃，结果按 priority 升序排列。
 */
export function parseProviders(raw: string): ProviderConfig[] {
	let list: unknown;
	try {
		list = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(list)) return [];

	const valid: ProviderConfig[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const p = item as Record<string, unknown>;
		if (typeof p.name !== 'string' || !p.name) continue;
		if (typeof p.baseUrl !== 'string' || !p.baseUrl.startsWith('http')) continue;
		if (typeof p.generateModel !== 'string' || !p.generateModel) continue;
		valid.push({
			name: p.name,
			priority: typeof p.priority === 'number' ? p.priority : 999,
			baseUrl: p.baseUrl,
			generateModel: p.generateModel,
			ocrModel: typeof p.ocrModel === 'string' && p.ocrModel ? p.ocrModel : undefined,
		});
	}
	return valid.sort((a, b) => a.priority - b.priority);
}
