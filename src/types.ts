/**
 * 类型定义
 */

/** 单个待处理材料（一个 R2 对象） */
export interface MaterialItem {
	/** R2 对象 key */
	r2Key: string;
	/** MIME 类型，如 "text/plain" / "image/png" */
	mimeType: string;
}

/** Hono 环境类型（仅覆盖 HTTP 路由用到的绑定；queue handler 与 DO 使用 wrangler 生成的 Env） */
export type AppEnv = {
	Bindings: {
		/** Service Binding → we-learning-suite-api（验票 / 状态回写 / 题目入库） */
		API_WORKER: Fetcher;
		/** R2 对象存储绑定（与 we-learning-suite-api 共享同一个 bucket） */
		R2_BUCKET: R2Bucket;
		/** Workers AI 绑定（通过 AI Gateway 路由） */
		AI: Ai;
		/** AI Gateway 路由名 —— 生成阶段 */
		AI_GENERATE_MODEL: string;
		/** AI Gateway 路由名 —— OCR 阶段 */
		AI_OCR_MODEL: string;
		/** AI Gateway 路由名 —— 规划阶段 */
		AI_PLAN_MODEL: string;
		/** AI Gateway ID */
		AI_GATEWAY_ID: string;
		QUIZ_QUEUE: Queue;
		/** OCR 异步处理 Durable Object */
		OCR_DO: DurableObjectNamespace;
	};
	Variables: Record<string, never>;
};

/** 队列消息体 */
export interface GenerateMessage {
	ticket: string;
	/** 待处理材料列表（由 API Worker 直接传 R2 key，不走预签名 URL） */
	materials: MaterialItem[];
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

/** 单个调用目标：provider 段进请求 URL，model（裸名）进请求体；dynamic 路由同构（provider='dynamic'） */
export interface ModelTarget {
	provider: string;
	model: string;
}

/** 统一调用目标（直连与路由同构） */
export type ChatTarget = ModelTarget;

/** wrangler secret：AI Gateway 鉴权 token（Authorization 头使用；用 wrangler secret put CF_AIG_TOKEN 设置） */
declare global {
	interface Env {
		CF_AIG_TOKEN: string;
	}
}

/** 下载并分诊后的材料 */
export interface ExtractedMaterial {
	/** 文本通道内容（txt/md 原文） */
	texts: string[];
	/** 图片通道内容（待 OCR） */
	images: Array<{ base64: string; mimeType: string }>;
}
