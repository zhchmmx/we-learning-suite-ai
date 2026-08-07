import { Hono } from 'hono';
import {
	IMAGE_MIME_TYPES,
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	MAX_MATERIALS,
	parseProviders,
} from './config';
import { handleGenerateMessage } from './pipeline';
import { ApiClientError, patchSessionStatus } from './services/api-client';
import { ocrImages } from './services/ocr';
import { walkProviderChain } from './services/providers';
import type { AppEnv, GenerateMessage, MaterialItem } from './types';

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
 * Body: { ticket, materials: Array<{ r2Key: string, mimeType: string }> }
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

	const materials = body.materials;
	if (
		!Array.isArray(materials) ||
		materials.length === 0 ||
		materials.length > MAX_MATERIALS ||
		materials.some((m) => !m || typeof m.r2Key !== 'string' || !m.r2Key || typeof m.mimeType !== 'string' || !m.mimeType)
	) {
		return c.json({ error: `"materials" must be an array of 1~${MAX_MATERIALS} items each with "r2Key" and "mimeType"` }, 400);
	}

	// 验票：借 API 项目的 PATCH 接口完成。假票 / 过期票当场被拒，
	// 不会为无效任务浪费任何模型调用
	try {
		await patchSessionStatus(c.env.API_WORKER, ticket, 'processing');
	} catch (err) {
		if (err instanceof ApiClientError && err.status >= 400 && err.status < 500) {
			return c.json({ error: 'Invalid or expired ticket' }, 401);
		}
		console.error('Ticket verification error:', err);
		return c.json({ error: 'Service temporarily unavailable' }, 503);
	}

	const message: GenerateMessage = {
		ticket,
		materials: materials as MaterialItem[],
	};
	await c.env.QUIZ_QUEUE.send(message);

	return c.json({ data: { status: 'processing', ticket } }, 202);
});

/**
 * POST /api/ocr
 * 图片转文字。本 Worker 已关闭公网入口（workers_dev: false），
 * 只能由 we-learning-suite-api 通过 Service Binding 内部调用，因此无需额外鉴权。
 *
 * Body: { images: [{ data: base64 字符串, mimeType: "image/jpeg"|"image/png"|"image/webp" }] }
 * 返回：{ data: { text } }
 *
 * 用途：客户端上传前把扫描件 PDF 渲染图 / 图片文件转成文字，
 * 保证服务端只存文本、出题管线只吃文本。
 */
app.post('/api/ocr', async (c) => {
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
