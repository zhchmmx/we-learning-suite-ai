import { GENERATION_MAX_TOKENS, MAX_TEXT_CHARS, PLAN_MAX_TOKENS } from './config';
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
	const plan: GenerationPlan = {
		totalCount: typeof planParsed?.totalCount === 'number' ? planParsed.totalCount : 0,
		types: Array.isArray(planParsed?.types) ? (planParsed.types as string[]).filter((t) => typeof t === 'string') : [],
	};
	if (plan.totalCount < 1 || plan.types.length === 0) {
		throw new TaskError('规划阶段输出异常（totalCount 或 types 无效）');
	}
	console.log(`Plan: ${plan.totalCount} questions, types=[${plan.types.join(', ')}]`);

	return { plan, corpus };
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
 * 上传阶段：把全部题目入库。成功后 API 自动把 session 置为 completed。
 */
export async function runUploadPhase(
	env: Env,
	ticket: string,
	questions: GeneratedQuestion[],
): Promise<void> {
	if (questions.length === 0) {
		throw new TaskError('所有批次中没有合格题目（JSON 解析失败或全部未通过校验）');
	}
	await uploadQuestions(env.API_WORKER, ticket, questions);
}
