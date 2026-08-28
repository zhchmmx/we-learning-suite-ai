import {
	DOC_TO_MARKDOWN_MIME_TYPES,
	IMAGE_MIME_TYPES,
	MAX_DOCUMENT_BYTES,
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	MIME_TO_EXTENSION,
	SCAN_MIN_CHARS,
	TEXT_MIME_TYPES,
} from '../config';
import type { ExtractedMaterial, MaterialItem } from '../types';

/**
 * 从 R2 存储桶直接读取材料 + 格式分诊。
 * 文本文件（txt/md）→ 原文进文本通道；图片（jpg/png/webp）→ base64 待 OCR；
 * 文档（PDF/Office/HTML/CSV）→ AI.toMarkdown 转 Markdown 进文本通道，
 * 其中 PDF 转不出文字（扫描件）或超过体积上限时返回 scanRequired 信号，
 * 由 Durable Object 走分块扫描兜底；其他格式 → 抛错。
 *
 * 不走公网预签名 URL：通过 Workers R2 Binding 内网直读，零延迟、零鉴权开销。
 */

/** 任务级失败：原因可直接写进 session 日志 / 返回给调用方 */
export class TaskError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TaskError';
	}
}

/** 需要 DO 分块扫描的 PDF（扫描件或超过 toMarkdown 体积上限） */
export interface ScanRequired {
	r2Key: string;
	size: number;
}

export interface ReadResult {
	material: ExtractedMaterial;
	/** 非空表示存在需要分块扫描抽取页图的 PDF，DO 完成扫描后应以图片材料恢复管线 */
	scanRequired: ScanRequired[];
}

/**
 * 规划阶段向 DO 发出的信号：存在需要分块扫描的扫描件/超大 PDF。
 * DO 捕获后进入 scanning 阶段；与 TaskError 区分——这不是失败，是流程分叉。
 */
export class ScanRequiredSignal extends Error {
	constructor(public readonly scans: ScanRequired[]) {
		super('scanned PDF detected, chunked scan required');
		this.name = 'ScanRequiredSignal';
	}
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function countNonWhitespace(text: string): number {
	return text.replace(/\s+/g, '').length;
}

/** 调 AI.toMarkdown 把文档转成 Markdown；加密/损坏/转换失败统一抛 TaskError */
async function convertToMarkdown(ai: Ai, buffer: ArrayBuffer, mimeType: string, label: string): Promise<string> {
	const extension = MIME_TO_EXTENSION[mimeType] ?? 'bin';
	let response;
	try {
		response = await ai.toMarkdown(
			{ name: `material.${extension}`, blob: new Blob([buffer]) },
			{ conversionOptions: { pdf: { metadata: false } } },
		);
	} catch (err) {
		console.error(`toMarkdown failed for ${label}:`, err);
		throw new TaskError(`第 ${label} 个文档转换失败，文件可能已加密或损坏`);
	}
	if (response.format === 'error') {
		throw new TaskError(`第 ${label} 个文档转换失败：${response.error}`);
	}
	return response.data.trim();
}

export async function readFromR2(
	bucket: R2Bucket,
	ai: Ai,
	materials: MaterialItem[],
): Promise<ReadResult> {
	const material: ExtractedMaterial = { texts: [], images: [] };
	const scanRequired: ScanRequired[] = [];

	for (const [index, item] of materials.entries()) {
		const label = String(index + 1);
		const object = await bucket.get(item.r2Key);

		if (!object) {
			throw new TaskError(`第 ${label} 个文件不存在（R2 key=${item.r2Key}）`);
		}

		// MIME 类型优先级：消息中携带的 > R2 HTTP 元数据
		const contentType = (item.mimeType || object.httpMetadata?.contentType || '')
			.split(';')[0]?.trim().toLowerCase() || '';

		if (TEXT_MIME_TYPES.has(contentType)) {
			const text = await object.text();
			if (text.trim()) material.texts.push(text.trim());
			continue;
		}

		if (IMAGE_MIME_TYPES.has(contentType)) {
			if (material.images.length >= MAX_IMAGES) {
				throw new TaskError(`图片数量超过上限（最多 ${MAX_IMAGES} 张），请拆分文档后重试`);
			}
			const buffer = await object.arrayBuffer();
			if (buffer.byteLength > MAX_IMAGE_BYTES) {
				throw new TaskError(`第 ${label} 张图片超过大小上限（${MAX_IMAGE_BYTES / 1024 / 1024}MB）`);
			}
			material.images.push({ base64: arrayBufferToBase64(buffer), mimeType: contentType });
			continue;
		}

		if (DOC_TO_MARKDOWN_MIME_TYPES.has(contentType)) {
			// 超大 PDF：跳过 toMarkdown（内存护栏），直接按扫描件走分块扫描
			if (contentType === 'application/pdf' && object.size > MAX_DOCUMENT_BYTES) {
				scanRequired.push({ r2Key: item.r2Key, size: object.size });
				continue;
			}

			const buffer = await object.arrayBuffer();
			if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
				throw new TaskError(`第 ${label} 个文档超过大小上限（${MAX_DOCUMENT_BYTES / 1024 / 1024}MB），请拆分后重试`);
			}

			const markdown = await convertToMarkdown(ai, buffer, contentType, label);

			// toMarkdown 对 PDF 没有页面级 OCR：输出过少说明是扫描件，交给分块扫描兜底
			if (contentType === 'application/pdf') {
				if (countNonWhitespace(markdown) < SCAN_MIN_CHARS) {
					scanRequired.push({ r2Key: item.r2Key, size: object.size });
					continue;
				}
			} else if (!markdown) {
				throw new TaskError(`第 ${label} 个文档未能提取到任何文本内容`);
			}

			if (markdown) material.texts.push(markdown);
			continue;
		}

		throw new TaskError(
			`不支持的文件格式（${contentType || '未知'}）。当前支持：TXT、Markdown、PDF、docx/xlsx/odt/ods、HTML/XML/CSV、JPEG/PNG/WebP 图片`,
		);
	}

	if (material.texts.length === 0 && material.images.length === 0 && scanRequired.length === 0) {
		throw new TaskError('所有文件都没有可处理的内容');
	}

	return { material, scanRequired };
}
