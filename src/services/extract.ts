import {
	DOCUMENT_MIME_TO_EXTENSION,
	IMAGE_MIME_TYPES,
	MAX_DOCUMENT_BYTES,
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	SCANNED_PDF_THRESHOLD_CHARS,
	TEXT_MIME_TYPES,
} from '../config';
import type { ExtractedMaterial, MaterialItem } from '../types';
import { extractPdfImages } from './pdf-scan';

/**
 * 从 R2 存储桶直接读取材料 + 格式分诊。
 * 文本文件（txt/md）→ 原文进文本通道；图片（jpg/png/webp）→ base64 待 OCR；
 * 文档（PDF/DOCX/XLSX）→ toMarkdown 转文本，扫描件 PDF 兜底抽图进 OCR 通道；
 * 其他格式 → 抛错。
 */

/** 任务级失败：原因可直接写进 session 日志 / 返回给调用方 */
export class TaskError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TaskError';
	}
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	return uint8ToBase64(new Uint8Array(buffer));
}

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

export async function readFromR2(opts: {
	bucket: R2Bucket;
	materials: MaterialItem[];
	ai: Ai;
	gatewayId: string;
}): Promise<ExtractedMaterial> {
	const { bucket, materials, ai, gatewayId } = opts;
	const material: ExtractedMaterial = { texts: [], images: [] };

	for (const [index, item] of materials.entries()) {
		const object = await bucket.get(item.r2Key);

		if (!object) {
			throw new TaskError(`第 ${index + 1} 个文件不存在（R2 key=${item.r2Key}）`);
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
				throw new TaskError(`第 ${index + 1} 张图片超过大小上限（${MAX_IMAGE_BYTES / 1024 / 1024}MB）`);
			}
			material.images.push({ base64: arrayBufferToBase64(buffer), mimeType: contentType });
			continue;
		}

		const ext = DOCUMENT_MIME_TO_EXTENSION.get(contentType);
		if (ext) {
			if (object.size > MAX_DOCUMENT_BYTES) {
				throw new TaskError(
					`第 ${index + 1} 个文件过大（上限 ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB），请拆分后重试`,
				);
			}
			const buffer = await object.arrayBuffer();
			const baseName = item.r2Key.split('/').pop() || `material-${index + 1}`;
			const fileName = baseName.endsWith(ext) ? baseName : `${baseName}${ext}`;

			let result: ConversionResponse;
			try {
				result = await ai.toMarkdown(
					{ name: fileName, blob: new Blob([buffer], { type: 'application/octet-stream' }) },
					{ gateway: { id: gatewayId } },
				);
			} catch (err) {
				throw new TaskError(
					`第 ${index + 1} 个文件转换失败：${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const isPdf = contentType === 'application/pdf';
			if (result.format === 'markdown') {
				const text = result.data.trim();
				if (text) material.texts.push(text);
				if (isPdf && text.replace(/\s+/g, '').length < SCANNED_PDF_THRESHOLD_CHARS) {
					scanPdfIntoImages(buffer, material);
				}
			} else if (isPdf) {
				scanPdfIntoImages(buffer, material);
			} else {
				throw new TaskError(`第 ${index + 1} 个文件转换失败：${result.error}`);
			}
			continue;
		}

		throw new TaskError(
			`不支持的文件格式（${contentType || '未知'}）。当前支持：TXT、Markdown、PDF、DOCX、XLSX、JPEG/PNG/WebP 图片`,
		);
	}

	if (material.texts.length === 0 && material.images.length === 0) {
		throw new TaskError('所有文件都没有可处理的内容');
	}

	return material;
}

function scanPdfIntoImages(buffer: ArrayBuffer, material: ExtractedMaterial): void {
	const budget = MAX_IMAGES - material.images.length;
	if (budget <= 0) return;
	const pages = extractPdfImages(new Uint8Array(buffer), budget);
	for (const page of pages) {
		material.images.push({ base64: uint8ToBase64(page), mimeType: 'image/jpeg' });
	}
	console.log(`Scanned PDF: extracted ${pages.length} page image(s) for OCR`);
}
