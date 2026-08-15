import type { GeneratedQuestion } from '../types';

/**
 * 出题：提示词构建 + 模型输出解析与校验。
 *
 * 题目结构与 we-learning-suite-api 的 README 契约严格一致：
 * - single_answer:  content { stem, options[] }      + answer { correctIndex }
 * - multiple_answer: content { stem, options[] }     + answer { correctIndices[] }
 * - true_false:     content { stem }                 + answer { correct }
 * - fill_blank:     content { stem }                 + answer { correct[], accept[][] }
 * - short_answer:   content { stem }                 + answer { correct, accept[]? }
 *
 * 两阶段流程：
 *   Phase 1 — 规划：模型分析材料，输出题目总数、题型分布等计划
 *   Phase 2 — 分批生成：按计划每批生成固定数量，带上已生成题目摘要防重复
 */

// ===== Phase 1: 规划 =====

export interface GenerationPlan {
	totalCount: number;
	types: string[];
}

export const PLAN_SYSTEM_PROMPT = `你是一款学习应用的出题规划专家。请分析用户提供的学习材料，制定出题计划。

首先判断材料性质：
A）材料本身包含题目（有题号、选项、填空、问答等题目特征）→ 统计其中已有的题目数量。
B）材料是知识性文本（课文、笔记、讲义等，没有现成题目）→ 根据材料的内容量和知识点密度，自行判断适合生成多少道题目。

输出要求（必须严格遵守）：
1. 只输出一个 JSON 对象，不要输出任何解释、前言或 markdown 代码块标记。
2. 结构为 { "totalCount": 数字, "types": ["题型1", "题型2", ...] }。
3. totalCount：
   - 情况 A（材料含题目）：与材料中实际题目数量一致，不要多也不要少。
   - 情况 B（材料为知识文本）：根据内容量和知识点密度自行判断，确保覆盖主要知识点。
4. types：从材料中题目的实际类型选取（情况 A），或根据材料特点选择最合适的 2~4 种题型（情况 B）。
   可选项："single_answer"（单选）、"multiple_answer"（多选）、"true_false"（判断）、
   "fill_blank"（填空）、"short_answer"（简答）。`;

export function buildPlanUserPrompt(materialText: string): string {
	return `请分析以下学习材料，判断其性质并制定出题计划：

${materialText}`;
}

// ===== Phase 2: 分批生成 =====

export const GENERATE_SYSTEM_PROMPT = `你是一款学习应用的出题专家。请根据用户提供的学习材料和出题计划，设计高质量的练习题。

输出要求（必须严格遵守）：
1. 只输出一个 JSON 对象，不要输出任何解释、前言或 markdown 代码块标记。
2. JSON 顶层结构为 { "questions": [ ... ] }。
3. 每道题必须是以下五种题型之一：
   - type 为 "single_answer"（单选题）：
     content 为 { "stem": 题干文本, "options": 选项数组（2~6 个字符串） }
     answer 为 { "correctIndex": 正确选项在 options 中的下标（从 0 开始的整数） }
   - type 为 "multiple_answer"（多选题）：
     content 为 { "stem": 题干文本, "options": 选项数组（2~6 个字符串） }
     answer 为 { "correctIndices": 所有正确选项在 options 中的下标数组（从 0 开始的整数数组，至少 2 个） }
   - type 为 "true_false"（判断题）：
     content 为 { "stem": 待判断的陈述 }
     answer 为 { "correct": 布尔值，表示该陈述是否正确 }
   - type 为 "fill_blank"（填空题）：
     content 为 { "stem": 题干文本，每个填空处用 ___ 表示 }
     answer 为 { "correct": [第1空标准答案, 第2空标准答案, ...], "accept": [[第1空可接受答案...], [第2空可接受答案...], ...] }
     一道题既可以只有一个空，也可以有多个空，取决于题目本身需要考查的知识点数量。stem 中 ___ 的数量必须与 correct 数组长度一致；每个 accept[i] 必须包含对应的 correct[i]。
     示例（单空）：content { "stem": "法国的首都是___" }, answer { "correct": ["巴黎"], "accept": [["巴黎", "Paris"]] }
     示例（多空）：content { "stem": "___是法国首都，___是日本首都" }, answer { "correct": ["巴黎", "东京"], "accept": [["巴黎", "Paris"], ["东京", "Tokyo"]] }
   - type 为 "short_answer"（简答题）：
     content 为 { "stem": 问题文本 }
     answer 为 { "correct": 参考答案文本, "accept": 可接受的关键要点字符串数组（用于辅助判分，必须包含参考答案的核心表述） }
4. 每道题可选 "tags" 字段：字符串数组，用于标注知识点标签。
5. 题目内容必须严格来自所给材料，不得编造材料中不存在的事实。
6. 根据材料特点选择题型，干扰项要有迷惑性但不能正确。
7. 严禁输出上述五种以外的题型，否则该题将被丢弃。
8. 如果提供了"已生成题目"列表，请避免与它们重复——考查同一知识点时须换角度或换题型。`;

/**
 * 构建分批生成的用户提示词。
 * @param materialText 完整材料文本
 * @param plan 规划结果
 * @param batchIndex 当前批次序号（从 1 开始）
 * @param batchSize 本批应生成题数
 * @param totalBatches 总批次数
 * @param previousStems 前面已生成题目的题干摘要（用于去重）
 */
export function buildBatchUserPrompt(
	materialText: string,
	plan: GenerationPlan,
	batchIndex: number,
	batchSize: number,
	totalBatches: number,
	previousStems: string[],
): string {
	let prompt = `出题计划：共 ${plan.totalCount} 题，题型从 [${plan.types.join(', ')}] 中选取。
当前是第 ${batchIndex}/${totalBatches} 批，请生成本批的 ${batchSize} 道题。

学习材料：
${materialText}`;

	if (previousStems.length > 0) {
		prompt += `\n\n已生成的题目（请勿重复）：\n${previousStems.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
	}

	return prompt;
}

/** 从已生成题目中提取题干摘要（用于传给下一批做去重参考） */
export function extractStems(questions: GeneratedQuestion[]): string[] {
	return questions.map((q) => {
		const stem = (q.content as Record<string, unknown>).stem;
		return typeof stem === 'string' ? stem.slice(0, 80) : '';
	}).filter(Boolean);
}

/**
 * 解析模型输出为题目数组。
 * 容错处理：剥掉可能的代码块围栏；JSON 解析失败返回 null。
 */
export function parseModelJson(raw: string): unknown {
	let text = raw.trim();

	// 剥掉 ```json ... ``` 围栏（防御性处理，提示词已禁止）
	const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fenceMatch) {
		text = fenceMatch[1].trim();
	}

	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * 逐题校验，返回合格题目（不合格的静默丢弃）。
 */
export function validateQuestions(parsed: unknown): GeneratedQuestion[] {
	if (!parsed || typeof parsed !== 'object') return [];

	const questions = (parsed as Record<string, unknown>).questions;
	if (!Array.isArray(questions)) return [];

	const valid: GeneratedQuestion[] = [];

	for (const item of questions) {
		if (!item || typeof item !== 'object') continue;
		const q = item as Record<string, unknown>;

		const { type, content, answer } = q;
		if (typeof type !== 'string') continue;
		if (!content || typeof content !== 'object') continue;
		if (!answer || typeof answer !== 'object') continue;

		const c = content as Record<string, unknown>;
		const a = answer as Record<string, unknown>;

		if (type === 'single_answer') {
			if (typeof c.stem !== 'string' || !c.stem.trim()) continue;
			if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 6) continue;
			if (c.options.some((o) => typeof o !== 'string' || !(o as string).trim())) continue;
			const correctIndex = a.correctIndex;
			if (typeof correctIndex !== 'number' || !Number.isInteger(correctIndex)) continue;
			if (correctIndex < 0 || correctIndex >= c.options.length) continue;
		} else if (type === 'true_false') {
			if (typeof c.stem !== 'string' || !c.stem.trim()) continue;
			if (typeof a.correct !== 'boolean') continue;
		} else if (type === 'fill_blank') {
			if (typeof c.stem !== 'string' || !c.stem.trim()) continue;
			// correct: 非空字符串数组（每空的标准答案）
			if (!Array.isArray(a.correct) || a.correct.length === 0) continue;
			if (a.correct.some((b) => typeof b !== 'string' || !(b as string).trim())) continue;
			// accept: 二维字符串数组，长度必须与 correct 一致
			if (!Array.isArray(a.accept) || a.accept.length !== a.correct.length) continue;
			if (a.accept.some((arr) => !Array.isArray(arr) || arr.some((x) => typeof x !== 'string'))) continue;
			// stem 中 ___ 数量必须与 correct 长度一致
			const blankCount = (c.stem.match(/_{3,}/g) || []).length;
			if (blankCount !== a.correct.length) continue;
		} else if (type === 'multiple_answer') {
			if (typeof c.stem !== 'string' || !c.stem.trim()) continue;
			if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 6) continue;
			if (c.options.some((o) => typeof o !== 'string' || !(o as string).trim())) continue;
			const correctIndices = a.correctIndices;
			if (!Array.isArray(correctIndices) || correctIndices.length < 2) continue;
			const seen = new Set<number>();
			let indicesValid = true;
			for (const idx of correctIndices) {
				if (typeof idx !== 'number' || !Number.isInteger(idx)) { indicesValid = false; break; }
				if (idx < 0 || idx >= c.options.length) { indicesValid = false; break; }
				if (seen.has(idx)) { indicesValid = false; break; }
				seen.add(idx);
			}
			if (!indicesValid) continue;
		} else if (type === 'short_answer') {
			if (typeof c.stem !== 'string' || !c.stem.trim()) continue;
			if (typeof a.correct !== 'string' || !a.correct.trim()) continue;
			if (a.accept !== undefined) {
				if (!Array.isArray(a.accept) || a.accept.some((x) => typeof x !== 'string')) continue;
			}
		} else {
			continue; // 未知题型
		}

		const question: GeneratedQuestion = { type, content, answer };
		if (Array.isArray(q.tags)) {
			const tags = q.tags.filter((t): t is string => typeof t === 'string').slice(0, 10);
			if (tags.length > 0) question.tags = tags;
		}
		valid.push(question);
	}

	return valid;
}
