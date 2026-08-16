import { GENERATE_MODEL_CHAIN, OCR_MODEL_CHAIN, PLAN_MODEL_CHAIN } from '../config';
import type { ChatTarget } from '../types';

/**
 * 模型选择解析器：按 USE_DIRECT_MODELS 决定用直连模型链还是 AI Gateway dynamic 路由。
 * - "true"（当前）：返回 config.ts 里的 { provider, model } 链——provider 进 URL、
 *   裸模型名进请求体（gateway.getUrl(provider) + fetch，BYOK 自动注入鉴权），
 *   由 llm.ts 在代码内按序 fallback
 * - "false"：返回单元素 [{ route }]，走 ai.run() 的 Gateway 路由路径（模型选择与 fallback 由 Gateway 负责）
 */

/** 规划阶段模型链 */
export function planModels(env: Env): ChatTarget[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...PLAN_MODEL_CHAIN]
		: [{ route: env.AI_PLAN_MODEL }];
}

/** 分批生成阶段模型链 */
export function generateModels(env: Env): ChatTarget[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...GENERATE_MODEL_CHAIN]
		: [{ route: env.AI_GENERATE_MODEL }];
}

/** OCR 模型链 */
export function ocrModels(env: Env): ChatTarget[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...OCR_MODEL_CHAIN]
		: [{ route: env.AI_OCR_MODEL }];
}
