import { COST_OCR, OCR_IMAGES_PER_CALL } from '../config';
import { ocrImages } from '../services/ocr';

/**
 * OCR Processing Durable Object
 *
 * 每客户端请求一个实例(taskId 做 identity)，用 alarm 状态机分批 OCR，
 * 绕过普通 HTTP invocation 的 CPU 上限(Bundled 50ms / Standard 30s)。
 *
 * 与 QuizGenerationDO 的区别：
 * - 不需要 Queue 中间层(图片通过 DO.fetch 直接传入)
 * - 图片以分片(chunk)存入 DO storage(绕开 SQLite 2MB 行上限)
 */

interface OCRTask {
	taskId: string;
	phase: 'pending' | 'processing' | 'done' | 'failed';
	batchIndex: number;
	totalBatches: number;
	imageCount: number;
	results: string[];
	error?: string;
}

/** 单张图片元数据(mimeType 相同的不重复存，但不同图片可能不同) */
interface ImageMeta {
	mimeType: string;
	chunkCount: number;
}

/** DO 存储单条上限 2MB，留安全裕量 */
const DO_CHUNK_SIZE = 1_800_000;

export class OCRProcessingDO implements DurableObject {
	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// ── POST /ocr → 接收图片 + 调度 alarm ──
		if (request.method === 'POST' && url.pathname === '/ocr') {
			const existing = await this.state.storage.get<OCRTask>('task');
			if (existing && existing.phase !== 'pending') {
				return new Response('Task already in progress or completed', { status: 409 });
			}

			const { taskId, images } = (await request.json()) as {
				taskId: string;
				images: Array<{ base64: string; mimeType: string }>;
			};

			// 图片分片存入 DO storage
			for (let i = 0; i < images.length; i++) {
				const img = images[i];
				const chunks = Math.ceil(img.base64.length / DO_CHUNK_SIZE);
				for (let c = 0; c < chunks; c++) {
					const chunk = img.base64.slice(c * DO_CHUNK_SIZE, (c + 1) * DO_CHUNK_SIZE);
					await this.state.storage.put(`img_${i}_${c}`, chunk);
				}
				await this.state.storage.put(`img_${i}_meta`, {
					mimeType: img.mimeType,
					chunkCount: chunks,
				});
			}

			const task: OCRTask = {
				taskId,
				phase: 'pending',
				batchIndex: 0,
				totalBatches: Math.ceil(images.length / OCR_IMAGES_PER_CALL),
				imageCount: images.length,
				results: [],
			};

			await this.state.storage.put('task', task);
			await this.scheduleAlarm();

			return new Response('Accepted', { status: 202 });
		}

		// ── GET /state → 返回当前进度/结果 ──
		if (request.method === 'GET' && url.pathname === '/state') {
			const task = await this.state.storage.get<OCRTask>('task');
			if (!task) {
				return new Response(JSON.stringify({ error: 'Task not found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const body: Record<string, unknown> = {
				taskId: task.taskId,
				phase: task.phase,
				batchIndex: task.batchIndex,
				totalBatches: task.totalBatches,
			};

			if (task.phase === 'done') {
				body.result = task.results.join('\n\n');
			}
			if (task.phase === 'failed') {
				body.error = task.error;
			}

			return new Response(JSON.stringify(body), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return new Response('Not found', { status: 404 });
	}

	async alarm(): Promise<void> {
		const task = await this.state.storage.get<OCRTask>('task');
		if (!task) return;

		try {
			if (task.phase === 'done' || task.phase === 'failed') return;

			task.phase = 'processing';
			await this.state.storage.put('task', task);

			const batchStart = task.batchIndex * OCR_IMAGES_PER_CALL;
			const batchEnd = Math.min(batchStart + OCR_IMAGES_PER_CALL, task.imageCount);
			const batchImages = await this.readImageBatch(batchStart, batchEnd);

			const text = await ocrImages({
				accountId: this.env.CF_ACCOUNT_ID,
				aigToken: this.env.CF_AIG_TOKEN,
				gatewayId: this.env.AI_GATEWAY_ID,
				model: this.env.AI_OCR_MODEL,
				customCost: COST_OCR,
				images: batchImages,
			});

			if (text.trim()) {
				task.results.push(text.trim());
			}
			task.batchIndex++;

			console.log(
				`OCR batch ${task.batchIndex}/${task.totalBatches} for task ${task.taskId}: ${text.length} chars`,
			);

			if (task.batchIndex < task.totalBatches) {
				await this.state.storage.put('task', task);
				await this.scheduleAlarm();
			} else {
				task.phase = 'done';
				await this.state.storage.put('task', task);
				await this.cleanupImages();
			}
		} catch (err) {
			task.phase = 'failed';
			task.error = err instanceof Error ? err.message : String(err);
			await this.state.storage.put('task', task);
			await this.cleanupImages();
			console.error(`OCR task ${task.taskId} failed:`, err);
		}
	}

	/** 从 DO storage 读回指定范围内的图片(合并分片) */
	private async readImageBatch(
		start: number,
		end: number,
	): Promise<Array<{ base64: string; mimeType: string }>> {
		const images: Array<{ base64: string; mimeType: string }> = [];
		for (let i = start; i < end; i++) {
			const meta = await this.state.storage.get<ImageMeta>(`img_${i}_meta`);
			if (!meta) continue;

			let base64 = '';
			for (let c = 0; c < meta.chunkCount; c++) {
				const chunk = await this.state.storage.get<string>(`img_${i}_${c}`);
				if (chunk) base64 += chunk;
			}
			images.push({ base64, mimeType: meta.mimeType });
		}
		return images;
	}

	/** 任务完成后清理图片分片，释放 DO 存储 */
	private async cleanupImages(): Promise<void> {
		const task = await this.state.storage.get<OCRTask>('task');
		if (!task) return;

		const ops: Array<Promise<boolean>> = [];
		for (let i = 0; i < task.imageCount; i++) {
			const meta = await this.state.storage.get<ImageMeta>(`img_${i}_meta`);
			if (!meta) continue;
			for (let c = 0; c < meta.chunkCount; c++) {
				ops.push(this.state.storage.delete(`img_${i}_${c}`));
			}
			ops.push(this.state.storage.delete(`img_${i}_meta`));
		}
		await Promise.all(ops);
	}

	private async scheduleAlarm(): Promise<void> {
		await this.state.storage.setAlarm(Date.now());
	}
}
