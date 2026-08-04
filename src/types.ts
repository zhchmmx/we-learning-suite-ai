/**
 * 类型定义
 */

/** 单个模型提供商配置（AI_PROVIDERS JSON 数组的一项） */
export interface ProviderConfig {
	/** 唯一标识，决定对应 secret 名：AI_PROVIDER_KEY_<NAME 大写> */
	name: string;
	/** 优先级，越小越先尝试 */
	priority: number;
	/** OpenAI 兼容 base URL，如 https://api.deepseek.com/v1 */
	baseUrl: string;
	/** 生成题目用的模型名 */
	generateModel: string;
	/** OCR 模型名（可选）。不填则图片 OCR 阶段自动跳过该提供商 */
	ocrModel?: string;
}

/** Hono 环境类型 */
export type AppEnv = {
	Bindings: {
		/** Service Binding → we-learning-suite-api（验票 / 状态回写 / 题目入库） */
		API_WORKER: Fetcher;
		AI_PROVIDERS: string;
		QUIZ_QUEUE: Queue;
	};
	Variables: Record<string, never>;
};

/** 队列消息体 */
export interface GenerateMessage {
	ticket: string;
	downloadUrls: string[];
	options?: {
		count?: number;
	};
}

/** 单道题目（与 we-learning-suite-api 的 /api/quiz/questions/batch 契约一致） */
export interface GeneratedQuestion {
	type: string;
	content: unknown;
	answer: unknown;
	tags?: string[];
}

/** chat completions 消息（content 允许纯文本或视觉多模态数组） */
export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | ContentPart[];
}

/** 下载并分诊后的材料 */
export interface ExtractedMaterial {
	/** 文本通道内容（txt/md 原文） */
	texts: string[];
	/** 图片通道内容（待 OCR） */
	images: Array<{ base64: string; mimeType: string }>;
}
