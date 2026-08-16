import { GENERATE_MODEL_CHAIN, OCR_MODEL_CHAIN, PLAN_MODEL_CHAIN } from '../config';

/**
 * 模型选择解析器：按 USE_DIRECT_MODELS 决定用直连模型链还是 AI Gateway dynamic 路由。
 * - "true"（当前）：返回 config.ts 里的具体模型链，由 llm.ts 在代码内按序 fallback
 * - "false"：返回单元素 [路由名]，恢复 Gateway 侧的模型选择与 fallback
 */

/** 规划阶段模型链 */
export function planModels(env: Env): string[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...PLAN_MODEL_CHAIN]
		: [env.AI_PLAN_MODEL];
}

/** 分批生成阶段模型链 */
export function generateModels(env: Env): string[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...GENERATE_MODEL_CHAIN]
		: [env.AI_GENERATE_MODEL];
}

/** OCR 模型链 */
export function ocrModels(env: Env): string[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...OCR_MODEL_CHAIN]
		: [env.AI_OCR_MODEL];
}
