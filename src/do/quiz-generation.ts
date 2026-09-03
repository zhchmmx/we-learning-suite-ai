import { runPlanningPhase, runBatchGenerationPhase, runUploadPhase } from '../pipeline';
import { ApiClientError, patchSessionStatus, renewTicket, type ProgressPayload } from '../services/api-client';
import { ContentScanError, scanQuestionBatch } from '../services/content-scan';
import {
	DONE_TASK_RETENTION_MS,
	FAILED_TASK_RETENTION_MS,
	GENERATION_BATCH_SIZE,
	IMAGE_MIME_TYPES,
	MAX_EMPTY_BATCH_STREAK,
	MAX_IMAGES,
	MAX_QUESTION_COUNT,
	PHASE_AUTO_RETRIES,
	STEM_WINDOW,
} from '../config';
import { ScanRequiredSignal, TaskError } from '../services/extract';
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
 * （failed 保留断点现场，同 ticket 重新触发时从断点续传，见 fetch() 的 resume 分支）
 */
interface TaskState {
	ticket: string;
	/** 发起用户 ID（随任务持久化，供各阶段调用模型时标识） */
	userId: string;
	materials: MaterialItem[];
	phase: 'pending' | 'planning' | 'scanning' | 'generating' | 'uploading' | 'done' | 'failed';
	/** 失败时所处的阶段（断点）。'planning' 是瞬态，resume 时映射回 'pending' 重入状态机 */
	failedPhase: TaskState['phase'] | null;
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
	/** 已成功上传的题数（片级断点；alarm 内自动重试续片用，resume 时因 API 已清库而重置 0） */
	uploadedCount: number;
	/** 阶段自动重试计数（成功推进时复位，用尽后置 failed） */
	alarmRetries: number;
	/** 连续空批计数（计数驱动循环的防死循环阀） */
	emptyStreak: number;
}

/** 断点续传时校验源材料是否一致（r2Key 集合比对；mimeType 变化不影响已提取内容） */
function sameMaterials(a: MaterialItem[], b: MaterialItem[]): boolean {
	if (a.length !== b.length) return false;
	const keys = new Set(a.map((m) => m.r2Key));
	return b.every((m) => keys.has(m.r2Key));
}

/**
 * 错误是否值得自动重试：
 * - API 4xx（取消信号 / 业务校验失败）确定性错误 → 不重试
 * - API 5xx（服务暂不可用）→ 可重试
 * - 内容审核：仅 CONTENT_SCAN_UNAVAILABLE（服务不可用）暂态可重试；block / review 未决永久
 * - TaskError（材料超限 / 连续空批等语义性失败）→ 不重试
 * - 其余（LLM 输出异常 / 网络错误等）→ 默认可重试
 */
function isRetriable(err: unknown): boolean {
	if (err instanceof ApiClientError) return err.status >= 500;
	if (err instanceof ContentScanError) return err.reasonCode === 'CONTENT_SCAN_UNAVAILABLE';
	if (err instanceof TaskError) return false;
	return true;
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
	 * 同 ticket 对 failed 任务重复投递 = 断点续传：从上次失败的阶段继续。
	 */
	async fetch(request: Request): Promise<Response> {
		// body 只能读一次：resume 与全新建任务两条路径共用同一份解析结果
		const { ticket, userId, materials } = (await request.json()) as {
			ticket: string;
			userId: string;
			materials: MaterialItem[];
		};

		// 幂等保护：已有任务在跑或已完成，拒绝重复投递
		const existing = await this.state.storage.get<TaskState>('task');
		if (existing && existing.phase === 'failed') {
			if (ticket !== existing.ticket) {
				return new Response('Ticket mismatch', { status: 409 });
			}
			if (existing.failedPhase && sameMaterials(existing.materials, materials)) {
				// ── 断点续传：DO storage 保留有全部检查点（corpus、已生成批次、扫描会话）──
				// planning 是 alarm() 里 pending 分支的瞬态，必须映射回 pending 才能重入状态机；
				// scanning / generating / uploading 都是持久断点分支，直接恢复即可
				existing.phase = existing.failedPhase === 'planning' ? 'pending' : existing.failedPhase;
				existing.failedPhase = null;
				existing.batchScanRetried = false; // 恢复的批次重新享有一次审核重试
				// 上传断点重置：API 复活路径已 DELETE questions（DB 为空），必须从第 0 片重传
				existing.uploadedCount = 0;
				// 版本漂移防护：改过 MAX_QUESTION_COUNT 后，存量任务的 plan 仍是旧值
				if (existing.plan) {
					existing.plan.totalCount = Math.min(existing.plan.totalCount, MAX_QUESTION_COUNT);
					existing.totalBatches = Math.ceil(existing.plan.totalCount / GENERATION_BATCH_SIZE);
				}
				existing.alarmRetries = 0;
				existing.emptyStreak = 0;
				await this.state.storage.put('task', existing);
				// setAlarm 是替换语义：覆盖掉 failed 时挂的清理 alarm，立即续跑
				await this.scheduleAlarm();
				console.log(`Session ${ticket} resumed from checkpoint (phase=${existing.phase}, batch=${existing.batchIndex}/${existing.totalBatches}, questions=${existing.allQuestions.length})`);
				return new Response('Resumed', { status: 202 });
			}
			// 旧格式断点（无 failedPhase，corpus 已被旧版错误处理删除）或源材料已变：
			// 放弃检查点，从头开始
			await this.state.storage.deleteAll();
		} else if (existing && existing.phase !== 'pending') {
			return new Response('Task already in progress or completed', { status: 409 });
		}

		const task: TaskState = {
			ticket,
			userId,
			materials,
			phase: 'pending',
			failedPhase: null,
			plan: null,
			batchIndex: 0,
			totalBatches: 0,
			allQuestions: [],
			allStems: [],
			batchScanRetried: false,
			scan: null,
			preScannedCorpus: '',
			uploadedCount: 0,
			alarmRetries: 0,
			emptyStreak: 0,
		};

		await this.state.storage.put('task', task);
		await this.scheduleAlarm();

		return new Response('Started', { status: 202 });
	}

	/**
	 * Alarm 状态机：每次触发只执行一个阶段，然后调度下一个 alarm（或结束）。
	 * done / failed 到达保留期后由 alarm 触发整体清理（storage 不再永久残留）。
	 */
	async alarm(): Promise<void> {
		const task = await this.state.storage.get<TaskState>('task');
		if (!task) return;

		// 终态保留期到点：整体清空（task + corpus + 一切）
		if (task.phase === 'done' || task.phase === 'failed') {
			await this.state.storage.deleteAll();
			return;
		}

		try {
			if (task.phase === 'pending') {
				// ── 规划阶段：读材料 → OCR → 调模型 → 存 plan ──
				// 上报 planning 进度（planning 含 OCR 可能耗时较长，让客户端尽早脱离"排队中"）
				await this.checkAndRenewTicket(task.ticket, { phase: 'planning' });
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

				// 规划阶段可能已耗时较长：续期 ticket，同时检测取消信号（4xx 抛出 → 中止）。
				// 顺带上报 generating 初始进度——客户端拿到 total 即可初始化进度条（0/N）
				await this.checkAndRenewTicket(task.ticket, {
					phase: 'generating',
					done: 0,
					total: plan.totalCount,
				});

				task.plan = plan;
				task.totalBatches = Math.ceil(plan.totalCount / GENERATION_BATCH_SIZE);
				task.batchIndex = 1;
				task.phase = 'generating';
				task.alarmRetries = 0; // 规划成功，复位阶段重试计数

				await this.state.storage.put('task', task);
				await this.state.storage.put('corpus', corpus);
				await this.scheduleAlarm();
			} else if (task.phase === 'scanning') {
				// ── 分块扫描：每轮 alarm 只扫一个块 + 预算内 OCR，直到抽够页图或扫到文件尾 ──
				if (!task.scan) {
					throw new Error('Missing scan session state');
				}
				await this.checkAndRenewTicket(task.ticket, { phase: 'scanning' });

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
				task.alarmRetries = 0; // 本轮扫描成功，复位阶段重试计数
				await this.state.storage.put('task', task);

				if (!done) {
					await this.scheduleAlarm();
					return;
				}

				// 扫描完成：累积语料 + 从 materials 移除被扫 PDF，回 pending 重新规划
				if (!session.corpus.trim()) {
					console.warn('[scan] session=' + task.ticket + ' 扫完 ' + session.pending.length + ' 个 PDF 但 0 抽取——疑似页图全被跳过');
				}
				const scannedKeys = new Set(session.pending.map((t) => t.r2Key));
				task.materials = task.materials.filter((m) => !scannedKeys.has(m.r2Key));
				task.preScannedCorpus = [task.preScannedCorpus, session.corpus].filter(Boolean).join('\n\n');
				task.scan = null;
				task.phase = 'pending';
				await this.state.storage.put('task', task);
				await this.scheduleAlarm();
			} else if (task.phase === 'generating') {
				// ── 分批生成：每轮 alarm 只跑一批（计数驱动，达标即进入上传）──
				// 取消检测检查点：session 已被取消时 renewTicket 返回 4xx，在此中止。
				// 顺带上报批进度（done = 已持久化的前 N-1 批题数）
				if (!task.plan) {
					throw new Error('Missing plan in task state');
				}
				await this.checkAndRenewTicket(task.ticket, {
					phase: 'generating',
					done: task.allQuestions.length,
					total: task.plan.totalCount,
				});

				// 已达计划总数 → 直接进入上传（无需再跑一轮空 alarm）
				const remaining = task.plan.totalCount - task.allQuestions.length;
				if (remaining <= 0) {
					task.phase = 'uploading';
					await this.state.storage.put('task', task);
					await this.scheduleAlarm();
					return;
				}

				const corpus = await this.state.storage.get<string>('corpus');
				if (!corpus) {
					throw new Error('Missing corpus in storage');
				}

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

				// 上限执法（不是迁就上传限制）：只收计划总数以内的题目。
				// 丢弃的仅有模型超发到计划总数之外的多余生成——所有收录题目仍会全部上传。
				const accepted = questions.slice(0, remaining);
				if (accepted.length === 0) {
					// 计数驱动循环的防死循环阀：连续多批 0 合格题目 → 判失败
					task.emptyStreak++;
					if (task.emptyStreak >= MAX_EMPTY_BATCH_STREAK) {
						throw new TaskError(`连续 ${MAX_EMPTY_BATCH_STREAK} 批没有合格题目（JSON 解析失败或全部未通过校验）`);
					}
					await this.state.storage.put('task', task);
					await this.scheduleAlarm();
					return;
				}
				task.emptyStreak = 0;

				task.batchScanRetried = false; // 本批通过审核，复位供下一批使用
				task.allQuestions.push(...accepted);
				// 累积去重窗口（此前是覆盖写，只跟上一批去重；题量大时跨批重复风险高）
				task.allStems = [...task.allStems, ...stems].slice(-STEM_WINDOW);
				task.batchIndex++;
				task.alarmRetries = 0; // 本批成功，复位阶段重试计数

				console.log(
					`Batch ${task.batchIndex - 1}/${task.totalBatches}: ${accepted.length} valid (total: ${task.allQuestions.length}/${task.plan.totalCount})`,
				);

				await this.state.storage.put('task', task);

				// 循环条件：计数驱动（不依赖 batchIndex 是否走完，以实际题数为准）
				if (task.allQuestions.length < task.plan.totalCount) {
					await this.scheduleAlarm();
				} else {
					// 全部批次完成 → 进入上传阶段
					task.phase = 'uploading';
					await this.state.storage.put('task', task);
					await this.scheduleAlarm();
				}
			} else if (task.phase === 'uploading') {
				// ── 上传：分片入库（片级断点，全部题目完整上传，严禁截断）──
				// 上传前续期 + 上报最终进度（原本 uploading 无 renew，此处顺带补上取消检测）
				if (!task.plan) {
					throw new Error('Missing plan in task state');
				}
				await this.checkAndRenewTicket(task.ticket, {
					phase: 'uploading',
					done: task.allQuestions.length,
					total: task.plan.totalCount,
				});

				// 断点已覆盖全部题目（末片已成功、但收尾落盘前中断）：直接收尾，
				// 否则空循环不再发片，session 会永远停在 processing（末片的 completed 由 API 端已写入）
				if (task.allQuestions.length > 0 && task.uploadedCount >= task.allQuestions.length) {
					console.warn(`Session ${task.ticket}: upload checkpoint already complete (${task.uploadedCount}), finalizing`);
				} else {
					// 自动重试时重入本分支，从 uploadedCount 断点续传，已成功的片不会重发；
					// API 端确定性 id + INSERT OR IGNORE 保证任何片重发都不会产生重复行
					// ?? 0：兼容旧格式任务（无 uploadedCount 字段），避免 offset 变 NaN 退回非幂等路径
					await runUploadPhase(this.env, task.ticket, task.allQuestions, task.uploadedCount ?? 0,
						async (uploadedCount) => {
							task.uploadedCount = uploadedCount;
							task.alarmRetries = 0; // 片成功，复位阶段重试计数
							await this.state.storage.put('task', task);
						});
				}
				console.log(`Uploaded ${task.allQuestions.length} questions for session ${task.ticket}`);

				task.phase = 'done';
				await this.state.storage.put('task', task);
				// 释放语料（大文本，不再需要），done 保留期到点后整体清空
				await this.state.storage.delete('corpus');
				await this.state.storage.setAlarm(Date.now() + DONE_TASK_RETENTION_MS);
			}
			// done / failed：不调度下一阶段 alarm——终态清理 alarm 已由对应路径挂上
		} catch (err) {
			await this.handleTaskError(task, err);
		}
	}

	/**
	 * 续期 ticket + 取消检测 + 进度上报（一个往返完成三件事）：
	 * - 4xx（session 已取消 / ticket 失效）→ 抛出，由 alarm 的 catch 中止任务
	 * - 5xx / 网络错误 → 暂态故障，记日志继续（不中断生成；进度丢失可接受，下轮补报）
	 */
	private async checkAndRenewTicket(ticket: string, progress?: ProgressPayload): Promise<void> {
		try {
			await renewTicket(this.env.API_WORKER, ticket, progress);
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
	 * - 可重试错误（LLM 抖动 / 网络 / 5xx / 暂态审核不可用）且未用完次数 → 原地重跑当前阶段
	 * - 4xx（取消 / ticket 失效）或用尽重试 → 标记 failed
	 * failed 后保留断点现场（corpus、已生成批次、扫描会话）供同 ticket 重试续传，
	 * 保留期到点由 alarm 兜底清空，storage 不再永久残留。
	 */
	private async handleTaskError(task: TaskState, err: unknown): Promise<void> {
		// 阶段自动重试：1000 题 ≈ 67 批，单批失败率会累积（p=1% → 裸成功率仅 51%），
		// 必须在任务级失败前消化掉暂态抖动，而不是让用户手动重试
		const retries = task.alarmRetries ?? 0;
		if (retries < PHASE_AUTO_RETRIES && isRetriable(err)) {
			task.alarmRetries = retries + 1;
			// planning 是 pending 分支内的瞬态阶段（仅为上报进度而落盘），alarm 状态机里没有 planning 分支。
			// 不复位成 pending，重入的 alarm 会匹配不到任何分支：不执行任何阶段、也不再调度下一轮，
			// 任务就此静默卡死——session 永远停在 processing，既不 done 也不 failed，还不打任何错误日志。
			// 与 resume 分支（fetch）里 failedPhase === 'planning' → 'pending' 的映射保持一致。
			const retriedPhase = task.phase;
			if (task.phase === 'planning') {
				task.phase = 'pending';
			}
			await this.state.storage.put('task', task);
			await this.scheduleAlarm();
			console.warn(`Phase ${retriedPhase} retry ${task.alarmRetries}/${PHASE_AUTO_RETRIES} for session ${task.ticket}:`, err);
			return; // 不置 failed、不动 session
		}

		// 取消信号：renewTicket / patchSessionStatus 收到 4xx（upload 的 4xx 是业务故障，不算取消）
		if (err instanceof ApiClientError && err.status < 500 && err.origin !== 'upload') {
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

		// 记录断点（phase 当前仍是失败发生时的工作阶段），保留 corpus 供续生成
		task.failedPhase = task.phase;
		task.phase = 'failed';
		await this.state.storage.put('task', task);
		// 保留期到点由 alarm 清理（setAlarm 替换语义，resume 时会被立即执行的调度覆盖）
		await this.state.storage.setAlarm(Date.now() + FAILED_TASK_RETENTION_MS);
	}

	/**
	 * 调度下一轮 alarm：上一阶段完成后尽快触发（delay = 0，用 Date.now() 而非 0，
	 * 因为 setAlarm 要求时间戳必须大于 0）。
	 */
	private async scheduleAlarm(): Promise<void> {
		await this.state.storage.setAlarm(Date.now());
	}
}
