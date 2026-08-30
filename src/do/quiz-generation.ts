import { runPlanningPhase, runBatchGenerationPhase, runUploadPhase } from '../pipeline';
import { ApiClientError, patchSessionStatus, renewTicket } from '../services/api-client';
import { ContentScanError, scanQuestionBatch } from '../services/content-scan';
import { GENERATION_BATCH_SIZE, IMAGE_MIME_TYPES, MAX_IMAGES } from '../config';
import { ScanRequiredSignal } from '../services/extract';
import { ocrImages } from '../services/ocr';
import { ocrModels } from '../services/models';
import { createScanSession, runScanRound, type ScanSession } from '../services/pdf-scan';
import type { GenerationPlan } from '../services/generate';
import type { GeneratedQuestion, MaterialItem } from '../types';

/**
 * DO 持久状态（每个 ticket 一个实例）
 *
 * 驱动整个出题管线的状态机：
 * pending → planning → [scanning (×N rounds)] → planning(恢复) → generating (×N batches) → uploading → done
 * planning 检出扫描件 PDF 时进入 scanning：每轮 alarm 只扫一个块 + 预算内 OCR（免费版 CPU 预算），
 * 抽出的文本累积进 DO storage，扫完回 pending 重新规划。任何阶段出错 → failed
 */
interface TaskState {
	ticket: string;
	/** 发起用户 ID（随任务持久化，供各阶段调用模型时标识） */
	userId: string;
	materials: MaterialItem[];
	phase: 'pending' | 'planning' | 'scanning' | 'generating' | 'uploading' | 'done' | 'failed';
	plan: GenerationPlan | null;
	batchIndex: number;
	totalBatches: number;
	allQuestions: GeneratedQuestion[];
	allStems: string[];
	/** 当前批是否已因输出侧内容审核 block 重生成过一次（每批最多一次） */
	batchScanRetried: boolean;
	/** 扫描件分块扫描会话（仅 scanning 阶段非空） */
	scan: ScanSession | null;
	/** 扫描完成累积的 OCR 语料（回 planning 时并入语料） */
	preScannedCorpus: string;
}

/**
 * Quiz Generation Durable Object
 *
 * 用 alarm() 把出题管线拆成多个独立 invocation，
 * 每个 alarm 只跑一个阶段（规划 / 一批扫描 / 一批生成 / 上传），
 * 各自有独立的 900 秒 wall time 预算，彻底解决长任务超时问题。
 */
export class QuizGenerationDO implements DurableObject {
	private env: Env;

	constructor(private state: DurableObjectState, env: Env) {
		this.env = env;
	}

	/**
	 * Queue 消费者调用：接收任务，存初始状态，调度第一个 alarm。
	 * 立即返回 202，让 Queue 消息被 ack。
	 */
	async fetch(request: Request): Promise<Response> {
		// 幂等保护：已有任务在跑或已完成，拒绝重复投递
		const existing = await this.state.storage.get<TaskState>('task');
		if (existing && existing.phase !== 'pending') {
			return new Response('Task already in progress or completed', { status: 409 });
		}

		const { ticket, userId, materials } = (await request.json()) as {
			ticket: string;
			userId: string;
			materials: MaterialItem[];
		};

		const task: TaskState = {
			ticket,
			userId,
			materials,
			phase: 'pending',
			plan: null,
			batchIndex: 0,
			totalBatches: 0,
			allQuestions: [],
			allStems: [],
			batchScanRetried: false,
			scan: null,
			preScannedCorpus: '',
		};

		await this.state.storage.put('task', task);
		await this.scheduleAlarm();

		return new Response('Started', { status: 202 });
	}

	/**
	 * Alarm 状态机：每次触发只执行一个阶段，然后调度下一个 alarm（或结束）。
	 */
	async alarm(): Promise<void> {
		const task = await this.state.storage.get<TaskState>('task');
		if (!task) return;

		try {
			if (task.phase === 'pending') {
				// ── 规划阶段：读材料 → OCR → 调模型 → 存 plan ──
				task.phase = 'planning';
				await this.state.storage.put('task', task);

				let plan: GenerationPlan;
				let corpus: string;
				try {
					({ plan, corpus } = await runPlanningPhase(
						this.env,
						task.ticket,
						task.userId,
						task.materials,
						task.preScannedCorpus,
					));
				} catch (err) {
					if (err instanceof ScanRequiredSignal) {
						// 扫描件 PDF：切换到分块扫描阶段，每轮 alarm 只扫一个块（免费版 CPU 预算）
						const imageCount = task.materials.filter((m) =>
							IMAGE_MIME_TYPES.has((m.mimeType || '').toLowerCase()),
						).length;
						task.scan = createScanSession(
							err.scans,
							Math.max(0, Math.min(MAX_IMAGES, MAX_IMAGES - imageCount)),
						);
						task.phase = 'scanning';
						await this.state.storage.put('task', task);
						await this.scheduleAlarm();
						return;
					}
					throw err;
				}

				// 规划阶段可能已耗时较长：续期 ticket，同时检测取消信号（4xx 抛出 → 中止）
				await this.checkAndRenewTicket(task.ticket);

				task.plan = plan;
				task.totalBatches = Math.ceil(plan.totalCount / GENERATION_BATCH_SIZE);
				task.batchIndex = 1;
				task.phase = 'generating';

				await this.state.storage.put('task', task);
				await this.state.storage.put('corpus', corpus);
				await this.scheduleAlarm();
			} else if (task.phase === 'scanning') {
				// ── 分块扫描：每轮 alarm 只扫一个块 + 预算内 OCR，直到抽够页图或扫到文件尾 ──
				if (!task.scan) {
					throw new Error('Missing scan session state');
				}
				await this.checkAndRenewTicket(task.ticket);

				const { session, done } = await runScanRound({
					bucket: this.env.R2_BUCKET,
					session: task.scan,
					ocr: (images) =>
						ocrImages({
							ai: this.env.AI,
							gatewayId: this.env.AI_GATEWAY_ID,
							authToken: this.env.CF_AIG_TOKEN,
							models: ocrModels(this.env),
							images,
							userId: task.userId,
						}),
				});
				task.scan = session;
				await this.state.storage.put('task', task);

				if (!done) {
					await this.scheduleAlarm();
					return;
				}

				// 扫描完成：累积语料 + 从 materials 移除被扫 PDF，回 pending 重新规划
				const scannedKeys = new Set(session.pending.map((t) => t.r2Key));
				task.materials = task.materials.filter((m) => !scannedKeys.has(m.r2Key));
				task.preScannedCorpus = [task.preScannedCorpus, session.corpus].filter(Boolean).join('\n\n');
				task.scan = null;
				task.phase = 'pending';
				await this.state.storage.put('task', task);
				await this.scheduleAlarm();
			} else if (task.phase === 'generating') {
				// ── 分批生成：每轮 alarm 只跑一批 ──
				// 取消检测检查点：session 已被取消时 renewTicket 返回 4xx，在此中止
				await this.checkAndRenewTicket(task.ticket);

				const corpus = await this.state.storage.get<string>('corpus');
				if (!corpus || !task.plan) {
					throw new Error('Missing corpus or plan in storage');
				}

				const remaining = task.plan.totalCount - task.allQuestions.length;
				const batchSize = Math.min(GENERATION_BATCH_SIZE, remaining);

				const { questions, stems } = await runBatchGenerationPhase(
					this.env,
					task.userId,
					corpus,
					task.plan,
					task.batchIndex,
					batchSize,
					task.totalBatches,
					task.allStems,
				);

				// 内容审核（输出侧）：入库前扫描本批题目。
				// block 且本批尚未重试过 → 重新生成同一批一次（batchIndex 不递增）；
				// 其余审核失败（再次 block / review 未决 / 服务不可用）抛出，由 handleTaskError 置 failed
				try {
					await scanQuestionBatch(this.env, questions, task.ticket, task.batchIndex);
				} catch (err) {
					if (err instanceof ContentScanError && err.reasonCode === 'CONTENT_BLOCKED' && !task.batchScanRetried) {
						console.warn(`Batch ${task.batchIndex} blocked by content scan, regenerating once`);
						task.batchScanRetried = true;
						await this.state.storage.put('task', task);
						await this.scheduleAlarm();
						return;
					}
					throw err;
				}

				task.batchScanRetried = false; // 本批通过审核，复位供下一批使用
				task.allQuestions.push(...questions);
				task.allStems = stems;
				task.batchIndex++;

				console.log(
					`Batch ${task.batchIndex - 1}/${task.totalBatches}: ${questions.length} valid (total: ${task.allQuestions.length})`,
				);

				await this.state.storage.put('task', task);

				if (task.batchIndex <= task.totalBatches) {
					await this.scheduleAlarm();
				} else {
					// 全部批次完成 → 进入上传阶段
					task.phase = 'uploading';
					await this.state.storage.put('task', task);
					await this.scheduleAlarm();
				}
			} else if (task.phase === 'uploading') {
				// ── 上传：入库（API 自动把 session 置为 completed）──
				await runUploadPhase(this.env, task.ticket, task.allQuestions);
				console.log(`Uploaded ${task.allQuestions.length} questions for session ${task.ticket}`);

				task.phase = 'done';
				await this.state.storage.put('task', task);
				// 释放语料（大文本，不再需要）
				await this.state.storage.delete('corpus');
			}
			// phase === 'done' | 'failed' → 不调度 alarm，自然结束
		} catch (err) {
			await this.handleTaskError(task, err);
		}
	}

	/**
	 * 续期 ticket + 取消检测：
	 * - 4xx（session 已取消 / ticket 失效）→ 抛出，由 alarm 的 catch 中止任务
	 * - 5xx / 网络错误 → 暂态故障，记日志继续（不中断生成）
	 */
	private async checkAndRenewTicket(ticket: string): Promise<void> {
		try {
			await renewTicket(this.env.API_WORKER, ticket);
		} catch (err) {
			if (err instanceof ApiClientError && err.status < 500) {
				console.warn(`Ticket renewal rejected (4xx), session likely cancelled:`, err.message);
				throw err;
			}
			console.error('Failed to renew ticket (non-fatal):', err);
		}
	}

	/**
	 * 任务级错误处理：
	 * - 4xx（取消 / ticket 失效）→ 直接标记 failed，不重试
	 * - 其他错误 → 尽力标记 failed，清理大体积语料
	 */
	private async handleTaskError(task: TaskState, err: unknown): Promise<void> {
		// 取消信号：renewTicket / patchSessionStatus 收到 4xx
		if (err instanceof ApiClientError && err.status < 500) {
			console.warn(`Session ${task.ticket} cancelled or ticket invalid:`, err.message);
		} else {
			console.error(`Task failed for session ${task.ticket}:`, err);
		}

		// 尽力把 session 标记为 failed（可能也因同样原因失败，忽略）；
		// 内容审核失败携带原因码，客户端据此展示对应文案
		try {
			const reason = err instanceof ContentScanError ? err.reasonCode : undefined;
			await patchSessionStatus(this.env.API_WORKER, task.ticket, 'failed', reason);
		} catch {
			// 忽略——API 可能不可达
		}

		task.phase = 'failed';
		await this.state.storage.put('task', task);
		await this.state.storage.delete('corpus');
	}

	/**
	 * 调度下一轮 alarm：上一阶段完成后尽快触发（delay = 0，用 Date.now() 而非 0，
	 * 因为 setAlarm 要求时间戳必须大于 0）。
	 */
	private async scheduleAlarm(): Promise<void> {
		await this.state.storage.setAlarm(Date.now());
	}
}
