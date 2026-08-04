/**
 * wrangler secret 不参与 `wrangler types` 生成，这里用接口合并补齐类型。
 * 每新增一个 secret（wrangler secret put <NAME>），在下面补一行。
 */
interface Env {
	/** 内部共享密钥：we-learning-suite-api 调用 /api/ocr 时携带的 X-Internal-Token */
	AI_INTERNAL_TOKEN: string;
}
