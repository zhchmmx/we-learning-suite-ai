import type { GeneratedQuestion } from '../types';

/**
 * 出题：提示词构建 + 模型输出解析与校验。
 *
 * 题目结构与 we-learning-suite-api 的 README 契约严格一致：
 * - single_choice: content { stem, options[] } + answer { correctIndex }
 * - true_false:    content { stem }            + answer { correct }
 * - fill_blank:    content { stem }            + answer { correct, accept[]? }
 */

export const GENERATE_SYSTEM_PROMPT = `你是一款学习应用的出题专家。请根据用户提供的学习材料设计高质量的练习题。

输出要求（必须严格遵守）：
1. 只输出一个 JSON 对象，不要输出任何解释、前言或 markdown 代码块标记。
2. JSON 顶层结构为 { "questions": [ ... ] }。
3. 每道题必须是以下三种题型之一：
   - type 为 "single_choice"（单选题）：
     content 为 { "stem": 题干文本, "options": 选项数组（2~6 个字符串） }
     answer 为 { "correctIndex": 正确选项在 options 中的下标（从 0 开始的整数） }
   - type 为 "true_false"（判断题）：
     content 为 { "stem": 待判断的陈述 }
     answer 为 { "correct": 布尔值，表示该陈述是否正确 }
   - type 为 "fill_blank"（填空题）：
     content 为 { "stem": 题干文本，用三个下划线 ___ 表示填空处 }
     answer 为 { "correct": 标准答案文本, "accept": 可接受的答案字符串数组（必须包含标准答案） }
4. 每道题可选 "tags" 字段：字符串数组，用于标注知识点标签。
5. 题目内容必须严格来自所给材料，不得编造材料中不存在的事实。
6. 根据材料特点选择题型，干扰项要有迷惑性但不能正确。`;

export function buildUserPrompt(materialText: string, count: number): string {
	return `请根据以下学习材料设计 ${count} 道练习题：\n\n${materialText}`;
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

		if (type === 'single_choice') {
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
