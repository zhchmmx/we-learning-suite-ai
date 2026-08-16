import { Hono } from 'hono';
import {
	IMAGE_MIME_TYPES,
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	MAX_MATERIALS,
} from './config';
import { ApiClientError, patchSessionStatus } from './services/api-client';
import type { AppEnv, GenerateMessage, MaterialItem } from './types';

// wrangler 要求 Durable Object 类从入口模块导出(durable_objects.class_name 解析到这里)
export { QuizGenerationDO } from './do/quiz-generation';
export { OCRProcessingDO } from './do/ocr-processing';

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
 * Body: { ticket, userId, materials: Array<{ r2Key: string, mimeType: string }> }
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

	const userId = body.userId;
	if (!userId || typeof userId !== 'string') {
		return c.json({ error: '"userId" is required' }, 400);
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
		userId,
		materials: materials as MaterialItem[],
	};
	await c.env.QUIZ_QUEUE.send(message);

	return c.json({ data: { status: 'processing', ticket } }, 202);
});

/**
 * POST /api/ocr
 * 图片转文字(异步)。
 *
 * Body: { images: [{ data: base64 字符串, mimeType: "image/jpeg"|"image/png"|"image/webp" }] }
 * 返回：{ data: { taskId, status: "processing" } }  ← 202
 *
 * 入参校验在 HTTP handler 里完成；实际 OCR 委托给 OCRProcessingDO(alarm 状态机)，
 * 绕过普通 HTTP invocation 的 CPU 上限。客户端通过 GET /api/ocr/status/:taskId 轮询结果。
 *
 * 用途：客户端上传前把扫描件 PDF 渲染图 / 图片文件转成文字，
 * 保证服务端只存文本、出题管线只吃文本。
 */
app.post('/api/ocr', async (c) => {
	let body: { userId?: unknown; images?: Array<{ data?: unknown; mimeType?: unknown }> };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	// 发起用户（由 API Worker 注入；可选，匿名调用不传），随任务进 DO → AI Gateway 请求标识
	const userId = body.userId;
	if (userId !== undefined && typeof userId !== 'string') {
		return c.json({ error: '"userId" must be a string' }, 400);
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
		if (Math.floor((img.data.length * 3) / 4) > MAX_IMAGE_BYTES) {
			return c.json({ error: `Image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit` }, 400);
		}
		normalized.push({ base64: img.data, mimeType: img.mimeType });
	}

	// 委托给 OCRProcessingDO：入队 → alarm 分批 OCR
	const taskId = `ocr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
	const id = c.env.OCR_DO.idFromName(taskId);
	const stub = c.env.OCR_DO.get(id);

	try {
		await stub.fetch('http://do/ocr', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ taskId, userId, images: normalized }),
		});
	} catch (err) {
		console.error('OCR DO dispatch failed:', err);
		return c.json({ error: 'Failed to dispatch OCR task' }, 502);
	}

	return c.json({ data: { taskId, status: 'processing' } }, 202);
});

/**
 * GET /api/ocr/status/:taskId
 * 轮询 OCR 任务进度和结果。
 *
 * 返回：
 * - processing: { data: { status: "processing", progress: { batch, total } } }
 * - done:       { data: { status: "done", text: "..." } }
 * - failed:     { data: { status: "failed", error: "..." } }  ← 500
 */
app.get('/api/ocr/status/:taskId', async (c) => {
	const taskId = c.req.param('taskId');
	if (!taskId) {
		return c.json({ error: 'taskId is required' }, 400);
	}

	const id = c.env.OCR_DO.idFromName(taskId);
	const stub = c.env.OCR_DO.get(id);

	let res: Response;
	try {
		res = await stub.fetch('http://do/state');
	} catch (err) {
		console.error('OCR DO state query failed:', err);
		return c.json({ error: 'Failed to query OCR task' }, 502);
	}

	const state = (await res.json()) as {
		taskId: string;
		phase: string;
		batchIndex?: number;
		totalBatches?: number;
		result?: string;
		error?: string;
	};

	if (res.status === 404) {
		return c.json({ error: 'Task not found' }, 404);
	}

	if (state.phase === 'done') {
		if (!state.result?.trim()) {
			return c.json({ error: 'No recognizable text in the images' }, 422);
		}
		return c.json({ data: { status: 'done', text: state.result } });
	}

	if (state.phase === 'failed') {
		return c.json({ data: { status: 'failed', error: state.error } }, 500);
	}

	return c.json({
		data: {
			status: 'processing',
			progress: { batch: state.batchIndex ?? 0, total: state.totalBatches ?? 0 },
		},
	});
});

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return app.fetch(request, env, ctx);
	},

	/** Queue 消费者：把任务交给 Durable Object，由 alarm 状态机驱动后续流程 */
	async queue(batch, env): Promise<void> {
		for (const message of batch.messages) {
			const msg = message.body as GenerateMessage;
			const stub = env.QUIZ_DO.get(env.QUIZ_DO.idFromName(msg.ticket));
			const res = await stub.fetch('http://do/start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(msg),
			});
			if (!res.ok) {
				// DO 拒绝（任务已在跑 / 已完成）→ ack 消息，不重试
				console.warn(`DO rejected message for ticket ${msg.ticket}: ${res.status}`);
				continue;
			}
		}
	},
} satisfies ExportedHandler<Env>;
