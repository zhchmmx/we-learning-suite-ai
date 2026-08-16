import { OCR_IMAGES_PER_CALL } from '../config';
import type { ChatMessage } from '../types';
import { chatCompletion } from './llm';

/**
 * 图片 OCR：调用视觉模型把图片转成文本。
 * 生成阶段永远只吃文本——这一步负责"从图里高保真还原文字"。
 */

const OCR_PROMPT =
	'请把图片中的文字内容逐字转录出来，保持原有的段落结构。' +
	'公式、表格、列表请尽量用纯文本方式保留其含义。' +
	'只输出转录的文字本身，不要添加任何解释、前后缀或 markdown 标记。' +
	'如果图片中没有任何可识别的文字，只输出一个空行。';

/**
 * 对一批图片做 OCR，返回拼接后的文本。
 * 图片按 OCR_IMAGES_PER_CALL 分批，每批一次模型调用（链内 fallback）；批与批之间串行。
 */
export async function ocrImages(opts: {
	ai: Ai;
	gatewayId: string;
	models: string[];
	images: Array<{ base64: string; mimeType: string }>;
}): Promise<string> {
	const { ai, gatewayId, models, images } = opts;
	const parts: string[] = [];

	for (let i = 0; i < images.length; i += OCR_IMAGES_PER_CALL) {
		const batch = images.slice(i, i + OCR_IMAGES_PER_CALL);

		const content: ChatMessage['content'] = [
			...batch.map((img) => ({
				type: 'image_url' as const,
				image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
			})),
			{ type: 'text' as const, text: OCR_PROMPT },
		];

		const text = await chatCompletion({
			ai,
			gatewayId,
			models,
			messages: [{ role: 'user', content }],
			// 图片里没有文字时模型返回空内容是正常结果
			allowEmpty: true,
		});

		if (text.trim()) parts.push(text.trim());
	}

	return parts.join('\n\n');
}
