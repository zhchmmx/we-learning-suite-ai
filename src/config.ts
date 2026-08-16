/** 图片通道限制 */
export const MAX_IMAGES = 15;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 单张 4MB（base64 编码是 CPU 操作，免费套餐要控制量）

/** 文本通道限制（超过直接判失败，提示用户拆分） */
export const MAX_TEXT_CHARS = 120_000;

/** 出题数量 */
export const DEFAULT_QUESTION_COUNT = 5;
export const MIN_QUESTION_COUNT = 1;
export const MAX_QUESTION_COUNT = 50;

/** 每次 OCR 请求最多携带的图片数 */
export const OCR_IMAGES_PER_CALL = 5;

/** 分批生成：每批生成的题目数上限 */
export const GENERATION_BATCH_SIZE = 15;

/** 模型调用 max_tokens：规划阶段（输出很小） */
export const PLAN_MAX_TOKENS = 4_000;

/** thinking 模型的规划阶段 max_tokens（思维链+答案一起算，需要更大空间） */
export const PLAN_THINKING_MAX_TOKENS = 32_000;

/** 模型调用 max_tokens：分批生成阶段（每批最多 15 道题，需要足够空间输出完整 JSON） */
export const GENERATION_MAX_TOKENS = 16_000;

/** 流式接收：最后一个 chunk 到达后，若超过此时间仍无新 chunk 则视为连接挂死，中止请求 */
export const CHUNK_IDLE_TIMEOUT_MS = 30_000;

/**
 * 直连模型链（USE_DIRECT_MODELS="true" 时生效）：主选不可用依次降级。
 * 不加退避等待、不对同一模型重试——网关侧已配置指数退避。
 * plan 与 generate 分开定义，便于以后独立调整。
 */
export const PLAN_MODEL_CHAIN = [
	'custom-dlut/Qwen3.5-122B-A10B',
	'custom-mimo/mimo-v2.5-pro',
	'deepseek-v4-flash',
] as const;

/** generate 模型链（当前与 plan 相同，可独立修改） */
export const GENERATE_MODEL_CHAIN = [
	'custom-dlut/Qwen3.5-122B-A10B',
	'custom-mimo/mimo-v2.5-pro',
	'deepseek-v4-flash',
] as const;

/** OCR 模型链 */
export const OCR_MODEL_CHAIN = [
	'custom-dlut/PaddleOCR-VL-1.5',
	'custom-mimo/mimo-v2.5',
] as const;
export const API_CALLBACK_TIMEOUT_MS = 15_000;

/** 受理端点校验 body 时材料的数量上限 */
export const MAX_MATERIALS = 50;

/** 支持的 MIME 类型 → 通道 */
export const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
export const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

