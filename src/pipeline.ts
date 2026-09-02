import { GENERATION_MAX_TOKENS, MAX_QUESTION_COUNT, MAX_TEXT_CHARS, PLAN_MAX_TOKENS, UPLOAD_CHUNK_SIZE } from './config';
import { uploadQuestions } from './services/api-client';
import { scanCorpus } from './services/content-scan';
import { readFromR2, ScanRequiredSignal, TaskError } from './services/extract';
import {
	buildBatchUserPrompt,
	buildPlanUserPrompt,
	extractStems,
	GENERATE_SYSTEM_PROMPT,
	GenerationPlan,
	parseModelJson,
	PLAN_SYSTEM_PROMPT,
	validateQuestions,
} from './services/generate';
import { chatCompletion } from './services/llm';
import { generateModels, ocrModels, planModels } from './services/models';
import { ocrImages } from './services/ocr';
import type { ExtractedMaterial, GeneratedQuestion, MaterialItem } from './types';

/**
 * 规划阶段：读材料 → OCR → 调模型 → 返回 plan + corpus。
 * 由 Durable Object alarm 调用，单次执行。
 */
export async function runPlanningPhase(
	env: Env,
	ticket: string,
	userId: string,
	materials: MaterialItem[],
	extraCorpus = '',
): Promise<{ plan: GenerationPlan; corpus: string }> {
	// 分诊与读取：先看 OCR 累积结果——扫描已消化全部材料时（materials 已移除被扫 PDF），
	// 空材料不视为错误，corpus 直接以 OCR 语料为基础；否则正常读 R2 材料并检查扫描信号
	let material: ExtractedMaterial;
	if (materials.length === 0 && extraCorpus.trim().length > 0) {
		material = { texts: [], images: [] };
	} else {
		const read = await readFromR2({
			bucket: env.R2_BUCKET,
			materials,
			ai: env.AI,
			gatewayId: env.AI_GATEWAY_ID,
		});
		if (read.scanRequired.length > 0) {
			throw new ScanRequiredSignal(read.scanRequired);
		}
		material = read.material;
	}

	// 图片走 OCR 转文字（生成永远只吃文本）
	let corpus = [material.texts.join('\n\n'), extraCorpus].filter(Boolean).join('\n\n');
	if (material.images.length > 0) {
		const ocrText = await ocrImages({
			ai: env.AI,
			gatewayId: env.AI_GATEWAY_ID,
			authToken: env.CF_AIG_TOKEN,
			models: ocrModels(env),
			images: material.images,
			userId,
		});
		corpus = [corpus, ocrText].filter(Boolean).join('\n\n');
	}

	if (!corpus.trim()) {
		throw new TaskError('未能从文档中获得任何文本内容（可能是无法识别的扫描件）');
	}
	if (corpus.length > MAX_TEXT_CHARS) {
		throw new TaskError(`材料文本超过上限（${MAX_TEXT_CHARS} 字符），请拆分文档后重试`);
	}

	// 内容审核（输入侧）：语料进入 LLM 前扫描，违规直接失败，
	// 省掉规划 + 分批生成的模型消耗（OCR 已完成，其开销不可避免）
	await scanCorpus(env, corpus, ticket);

	// 调模型规划：分析材料，决定题目总数和题型分布
	const planRaw = await chatCompletion({
		ai: env.AI,
		gatewayId: env.AI_GATEWAY_ID,
		authToken: env.CF_AIG_TOKEN,
		userId,
		models: planModels(env),
		messages: [
			{ role: 'system', content: PLAN_SYSTEM_PROMPT },
			{ role: 'user', content: buildPlanUserPrompt(corpus) },
		],
		jsonOutput: true,
		maxTokens: PLAN_MAX_TOKENS,
	});
	console.log('Plan generated');

	const planParsed = parseModelJson(planRaw) as Record<string, unknown> | null;
	// 容错归一：模型可能输出 "1,024" / "200题" / 200.0 等非标准数字
	const rawTotal = parseTotalCount(planParsed?.totalCount);
	const types = Array.isArray(planParsed?.types)
		? (planParsed.types as string[]).filter((t) => typeof t === 'string')
		: [];
	if (rawTotal < 1 || types.length === 0) {
		throw new TaskError('规划阶段输出异常（totalCount 或 types 无效）');
	}
	// 每文件出题上限（提示词已同步约束，此处为服务端强制兜底）
	const totalCount = Math.min(rawTotal, MAX_QUESTION_COUNT);
	if (totalCount < rawTotal) {
		console.warn(`Plan totalCount clamped: ${rawTotal} → ${totalCount} (MAX_QUESTION_COUNT)`);
	}
	const plan: GenerationPlan = {
		totalCount,
		// 材料实际题量估计（未 clamp），超限时可供客户端提示"材料约 N 题，本次生成上限 M 题"
		estimatedTotal: rawTotal,
		types,
	};
	console.log(`Plan: ${plan.totalCount} questions (material estimate: ${plan.estimatedTotal}), types=[${plan.types.join(', ')}]`);

	return { plan, corpus };
}

/**
 * 规划 totalCount 容错解析：接受 number / "1,024" / "200题" 等形态，归一为正整数。
 * 无法解析返回 0（由调用方判无效）。
 */
function parseTotalCount(v: unknown): number {
	if (typeof v === 'number' && Number.isFinite(v)) {
		return Math.floor(v);
	}
	if (typeof v === 'string') {
		const n = parseInt(v.replace(/[,，\s题道]/g, ''), 10);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

/**
 * 单批生成阶段：调模型生成一批题目 → 校验 → 返回题目 + 更新后的 stems。
 * 由 Durable Object alarm 调用，每批一次。
 */
export async function runBatchGenerationPhase(
	env: Env,
	userId: string,
	corpus: string,
	plan: GenerationPlan,
	batchIndex: number,
	batchSize: number,
	totalBatches: number,
	allStems: string[],
): Promise<{ questions: GeneratedQuestion[]; stems: string[] }> {
	const batchRaw = await chatCompletion({
		ai: env.AI,
		gatewayId: env.AI_GATEWAY_ID,
		authToken: env.CF_AIG_TOKEN,
		userId,
		models: generateModels(env),
		messages: [
			{ role: 'system', content: GENERATE_SYSTEM_PROMPT },
			{
				role: 'user',
				content: buildBatchUserPrompt(corpus, plan, batchIndex, batchSize, totalBatches, allStems),
			},
		],
		jsonOutput: true,
		maxTokens: GENERATION_MAX_TOKENS,
	});
	console.log(`Batch ${batchIndex}/${totalBatches} generated (raw length=${batchRaw.length})`);

	const questions = validateQuestions(parseModelJson(batchRaw));
	const stems = extractStems(questions);

	console.log(`Batch ${batchIndex}: ${questions.length} valid questions`);

	return { questions, stems };
}

/**
 * 上传阶段：把全部题目分片入库（所有题目必须完整上传，严禁截断）。
 * - 题目总数 > 单请求上限（API MAX_BATCH_SIZE=500）时自动分片，每片 UPLOAD_CHUNK_SIZE 题
 * - startOffset：断点续传起点（已成功上传的题数），自动重试时从断点续，不重发已传片
 * - onChunkUploaded：每片成功后的回调（DO 用于把 uploadedCount 断点落盘）
 * 仅最后一片会把 session 置为 completed（API 端 final 语义）。
 */
export async function runUploadPhase(
	env: Env,
	ticket: string,
	questions: GeneratedQuestion[],
	startOffset: number,
	onChunkUploaded?: (uploadedCount: number) => Promise<void>,
): Promise<void> {
	if (questions.length === 0) {
		throw new TaskError('所有批次中没有合格题目（JSON 解析失败或全部未通过校验）');
	}
	if (startOffset < 0 || startOffset > questions.length) {
		throw new TaskError(`Invalid upload checkpoint: ${startOffset}/${questions.length}`);
	}

	const pending = questions.slice(startOffset);
	for (let i = 0; i < pending.length; i += UPLOAD_CHUNK_SIZE) {
		const chunk = pending.slice(i, i + UPLOAD_CHUNK_SIZE);
		const offset = startOffset + i;
		const final = i + UPLOAD_CHUNK_SIZE >= pending.length;
		await uploadQuestions(env.API_WORKER, ticket, chunk, offset, final);
		if (onChunkUploaded) {
			await onChunkUploaded(startOffset + i + chunk.length);
		}
	}
}
