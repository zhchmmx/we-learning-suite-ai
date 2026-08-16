import { GENERATE_MODEL_CHAIN, OCR_MODEL_CHAIN, PLAN_MODEL_CHAIN } from '../config';
import type { ChatTarget } from '../types';

/**
 * 模型选择解析器：按 USE_DIRECT_MODELS 决定用直连模型链还是 AI Gateway dynamic 路由。
 * 两种模式产出同构的 { provider, model } 目标，统一走 provider 透传端点
 * （/{provider}/v1/chat/completions，body 放裸模型名）：
 * - "true"（当前）：返回 config.ts 里的直连链，由 llm.ts 在代码内按序 fallback
 * - "false"：返回 { provider: 'dynamic', model: <裸路由名> }，路由选择与 fallback 由 Gateway 负责
 */

/** 规划阶段模型链 */
export function planModels(env: Env): ChatTarget[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...PLAN_MODEL_CHAIN]
		: [{ provider: 'dynamic', model: env.AI_PLAN_MODEL.replace(/^dynamic\//, '') }];
}

/** 分批生成阶段模型链 */
export function generateModels(env: Env): ChatTarget[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...GENERATE_MODEL_CHAIN]
		: [{ provider: 'dynamic', model: env.AI_GENERATE_MODEL.replace(/^dynamic\//, '') }];
}

/** OCR 模型链 */
export function ocrModels(env: Env): ChatTarget[] {
	return env.USE_DIRECT_MODELS === 'true'
		? [...OCR_MODEL_CHAIN]
		: [{ provider: 'dynamic', model: env.AI_OCR_MODEL.replace(/^dynamic\//, '') }];
}
