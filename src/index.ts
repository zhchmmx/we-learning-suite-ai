import { Hono } from 'hono';
import {
	DEFAULT_QUESTION_COUNT,
	MAX_DOWNLOAD_URLS,
	MAX_QUESTION_COUNT,
	MIN_QUESTION_COUNT,
} from './config';
import { handleGenerateMessage } from './pipeline';
import { ApiClientError, patchSessionStatus } from './services/api-client';
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
