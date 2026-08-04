import { Hono } from 'hono';
import {
	DEFAULT_QUESTION_COUNT,
	IMAGE_MIME_TYPES,
	MAX_DOWNLOAD_URLS,
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	MAX_QUESTION_COUNT,
	MIN_QUESTION_COUNT,
	parseProviders,
} from './config';
import { handleGenerateMessage } from './pipeline';
import { ApiClientError, patchSessionStatus } from './services/api-client';
import { ocrImages } from './services/ocr';
import { walkProviderChain } from './services/providers';
import type { AppEnv, GenerateMessage } from './types';

/**
 * we-learning-suite-ai —— 出题 AI Worker 入口
 *
 * 客户端全程不知道本 Worker 的存在：
 * 触发来自 we-learning-suite-api 的服务端调用，凭证是 quiz session 的 ticket。
 */

const app = new Hono<AppEnv>();

/** 健康检查（无鉴权） */
app.get('/health', (c) =>
	c.json({
		status: 'ok',
		service: 'we-learning-suite-ai',
		timestamp: new Date().toISOString(),
	}),
);

/**
 * POST /api/quiz/generate
 * 受理出题任务（由 we-learning-suite-api 服务端调用，凭证 = ticket）
 *
 * Body: { ticket, downloadUrls: string[], options?: { count?: number } }
 * 流程：PATCH status=processing 验票 → 消息入队 → 立刻返回 202
 */
app.post('/api/quiz/generate', async (c) => {
	let body: Partial<GenerateMessage>;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const ticket = body.ticket;
	if (!ticket || typeof ticket !== 'string') {
		return c.json({ error: '"ticket" is required' }, 400);
	}

	const downloadUrls = body.downloadUrls;
	if (
		!Array.isArray(downloadUrls) ||
		downloadUrls.length === 0 ||
		downloadUrls.length > MAX_DOWNLOAD_URLS ||
		downloadUrls.some((u) => typeof u !== 'string' || !u.startsWith('http'))
	) {
		return c.json({ error: `"downloadUrls" must be an array of 1~${MAX_DOWNLOAD_URLS} HTTP(S) URLs` }, 400);
	}

	let count = DEFAULT_QUESTION_COUNT;
	if (body.options?.count !== undefined) {
		const n = body.options.count;
		if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_QUESTION_COUNT || n > MAX_QUESTION_COUNT) {
			return c.json(
				{ error: `"options.count" must be an integer between ${MIN_QUESTION_COUNT} and ${MAX_QUESTION_COUNT}` },
				400,
			);
		}
		count = n;
	}

	// 验票：借 API 项目的 PATCH 接口完成。假票 / 过期票当场被拒，
	// 不会为无效任务浪费任何模型调用
	try {
		await patchSessionStatus(c.env.API_BASE_URL, ticket, 'processing');
	} catch (err) {
		if (err instanceof ApiClientError && err.status >= 400 && err.status < 500) {
			return c.json({ error: 'Invalid or expired ticket' }, 401);
		}
		console.error('Ticket verification error:', err);
		return c.json({ error: 'Service temporarily unavailable' }, 503);
	}

	const message: GenerateMessage = {
		ticket,
		downloadUrls: downloadUrls as string[],
		options: { count },
	};
	await c.env.QUIZ_QUEUE.send(message);

	return c.json({ data: { status: 'processing', ticket } }, 202);
});

/**
 * POST /api/ocr
 * 图片转文字（由 we-learning-suite-api 代理转发，客户端不直接访问本 Worker）
 *
 * 鉴权：请求头 X-Internal-Token 必须与 secret AI_INTERNAL_TOKEN 一致
 * Body: { images: [{ data: base64 字符串, mimeType: "image/jpeg"|"image/png"|"image/webp" }] }
 * 返回：{ data: { text } }
 *
 * 用途：客户端上传前把扫描件 PDF 渲染图 / 图片文件转成文字，
 * 保证服务端只存文本、出题管线只吃文本。
 */
app.post('/api/ocr', async (c) => {
	// 内部令牌校验（secret 未配置时一律拒绝，fail closed）
	const token = c.req.header('X-Internal-Token');
	if (!c.env.AI_INTERNAL_TOKEN || token !== c.env.AI_INTERNAL_TOKEN) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	let body: { images?: Array<{ data?: unknown; mimeType?: unknown }> };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	const images = body.images;
	if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES) {
		return c.json({ error: `"images" must be an array of 1~${MAX_IMAGES} items` }, 400);
	}

	const normalized: Array<{ base64: string; mimeType: string }> = [];
	for (const img of images) {
		if (!img || typeof img.data !== 'string' || typeof img.mimeType !== 'string') {
			return c.json({ error: 'Each image needs "data" (base64) and "mimeType"' }, 400);
		}
		if (!IMAGE_MIME_TYPES.has(img.mimeType)) {
			return c.json({ error: `Unsupported image type: ${img.mimeType}` }, 400);
		}
		// base64 长度 × 3/4 ≈ 原始字节数
		if (Math.floor((img.data.length * 3) / 4) > MAX_IMAGE_BYTES) {
			return c.json({ error: `Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit` }, 400);
		}
		normalized.push({ base64: img.data, mimeType: img.mimeType });
	}

	let text: string;
	try {
		const { result } = await walkProviderChain(
			c.env,
			parseProviders(c.env.AI_PROVIDERS),
			(provider, apiKey) =>
				ocrImages({
					baseUrl: provider.baseUrl,
					apiKey,
					model: provider.ocrModel as string,
					images: normalized,
				}),
			(p) => !!p.ocrModel,
		);
		text = result;
	} catch (err) {
		console.error('OCR failed:', err);
		return c.json({ error: 'OCR failed: no provider available' }, 502);
	}

	if (!text.trim()) {
		return c.json({ error: 'No recognizable text in the images' }, 422);
	}

	return c.json({ data: { text } });
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return app.fetch(request, env, ctx);
	},

	/** Queue 消费者：出题任务异步执行 */
	async queue(batch, env): Promise<void> {
		for (const message of batch.messages) {
			await handleGenerateMessage(message.body as GenerateMessage, env);
		}
	},
} satisfies ExportedHandler<Env>;
