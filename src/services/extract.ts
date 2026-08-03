import { DOWNLOAD_TIMEOUT_MS, IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, TEXT_MIME_TYPES } from '../config';
import type { ExtractedMaterial } from '../types';

/**
 * 下载文档 + 格式分诊。
 * 文本文件（txt/md）→ 原文进文本通道；图片（jpg/png/webp）→ base64 待 OCR；
 * 其他格式（含 PDF）→ 抛错（v1 不支持，等客户端转换任务落地后才会有 PDF 进来）。
 */

/** 任务级失败：原因可直接写进 session 日志 / 返回给调用方 */
export class TaskError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TaskError';
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

export async function downloadAndExtract(downloadUrls: string[]): Promise<ExtractedMaterial> {
	const material: ExtractedMaterial = { texts: [], images: [] };

	for (const [index, url] of downloadUrls.entries()) {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
			// 注意：预签名 URL 不能带任何 Authorization 头，签名本身就是凭证
		});

		if (!res.ok) {
			throw new TaskError(`下载第 ${index + 1} 个文件失败（HTTP ${res.status}）`);
		}

		const contentType = (res.headers.get('Content-Type') || '').split(';')[0]?.trim().toLowerCase() || '';

		if (TEXT_MIME_TYPES.has(contentType)) {
			const text = await res.text();
			if (text.trim()) material.texts.push(text.trim());
			continue;
		}

		if (IMAGE_MIME_TYPES.has(contentType)) {
			if (material.images.length >= MAX_IMAGES) {
				throw new TaskError(`图片数量超过上限（最多 ${MAX_IMAGES} 张），请拆分文档后重试`);
			}
			const buffer = await res.arrayBuffer();
			if (buffer.byteLength > MAX_IMAGE_BYTES) {
				throw new TaskError(`第 ${index + 1} 张图片超过大小上限（${MAX_IMAGE_BYTES / 1024 / 1024}MB）`);
			}
			material.images.push({ base64: arrayBufferToBase64(buffer), mimeType: contentType });
			continue;
		}

		throw new TaskError(
			`不支持的文件格式（${contentType || '未知'}）。当前支持：TXT、Markdown、JPEG/PNG/WebP 图片；PDF 与 Office 文档请等待后续版本支持`,
		);
	}

	if (material.texts.length === 0 && material.images.length === 0) {
		throw new TaskError('所有文件都没有可处理的内容');
	}

	return material;
}
