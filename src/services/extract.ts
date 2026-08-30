import {
	DOCUMENT_MIME_TO_EXTENSION,
	IMAGE_MIME_TYPES,
	MAX_DOCUMENT_BYTES,
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	SCANNED_PDF_THRESHOLD_CHARS,
	SCANNED_PDF_STRIP_THRESHOLD_CHARS,
	TEXT_MIME_TYPES,
} from '../config';
import type { ExtractedMaterial, MaterialItem } from '../types';

/**
 * 从 R2 存储桶直接读取材料 + 格式分诊。
 * 文本文件（txt/md）→ 原文进文本通道；图片（jpg/png/webp）→ base64 待 OCR；
 * 文档（PDF/DOCX/XLSX）→ toMarkdown 转文本，扫描件 PDF 返回 scanRequired 信号
 * 交由 DO 走分块扫描 OCR；其他格式 → 抛错。
 */

/** 任务级失败：原因可直接写进 session 日志 / 返回给调用方 */
export class TaskError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TaskError';
	}
}

/**
 * 剥掉 Cloudflare toMarkdown 对纯扫描件 PDF 输出的模板壳：
 * - ## Metadata 段（固定元数据键值）
 * - ### Page N 空页占位行（Page + 数字、无正文）
 * 能剥多少剥多少；剥不掉的格式原样保留，调用方回退按总字符数判断（不报错）。
 * 兼容 \n 与 \r\n 行尾。
 */
function stripToMarkdownShell(text: string): string {
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	let inMetadata = false;
	for (const line of lines) {
		// 进入 ## Metadata 段
		if (/^##\s+Metadata\s*$/.test(line)) {
			inMetadata = true;
			continue;
		}
		// Metadata 段内：遇到下一个二级标题（## Contents 等）则出段，其余行丢弃
		if (inMetadata) {
			if (/^##\s+/.test(line)) inMetadata = false;
			else continue;
		}
		// ### Page N 空占位：整行仅 Page + 数字，丢弃
		if (/^###\s+Page\s+\d+\s*$/.test(line)) continue;
		kept.push(line);
	}
	return kept.join('\n');
}

/** 需要 DO 分块扫描的 PDF（扫描件） */
export interface ScanRequired {
	r2Key: string;
	size: number;
}

export interface ReadResult {
	material: ExtractedMaterial;
	/** 非空表示存在需要分块扫描抽取页图的 PDF，DO 应进入 scanning 阶段 */
	scanRequired: ScanRequired[];
}

/** 规划阶段向 DO 发出的流程分叉信号（非失败，区别于 TaskError） */
export class ScanRequiredSignal extends Error {
	constructor(public readonly scans: ScanRequired[]) {
		super('scanned PDF detected, chunked scan required');
		this.name = 'ScanRequiredSignal';
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
}): Promise<ReadResult> {
	const { bucket, materials, ai, gatewayId } = opts;
	const material: ExtractedMaterial = { texts: [], images: [] };
	const scanRequired: ScanRequired[] = [];

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
				// 扫描件 PDF：toMarkdown 只产出模板壳（元数据+空页占位），交给 DO 分块扫描 OCR
				// 判据：剥壳后正文极少（纯扫描件）；剥壳失败则回退用总字符数（原逻辑），都不报错
				if (isPdf) {
					const stripped = stripToMarkdownShell(text);
					const strippedLen = stripped.replace(/\s+/g, '').length;
					const totalLen = text.replace(/\s+/g, '').length;
					if (strippedLen < SCANNED_PDF_STRIP_THRESHOLD_CHARS || totalLen < SCANNED_PDF_THRESHOLD_CHARS) {
						scanRequired.push({ r2Key: item.r2Key, size: object.size });
						continue;
					}
				}
				if (text) material.texts.push(text);
			} else if (isPdf) {
				scanRequired.push({ r2Key: item.r2Key, size: object.size });
			} else {
				throw new TaskError(`第 ${index + 1} 个文件转换失败：${result.error}`);
			}
			continue;
		}

		throw new TaskError(
			`不支持的文件格式（${contentType || '未知'}）。当前支持：TXT、Markdown、PDF、DOCX、XLSX、JPEG/PNG/WebP 图片`,
		);
	}

	if (material.texts.length === 0 && material.images.length === 0 && scanRequired.length === 0) {
		throw new TaskError('所有文件都没有可处理的内容（若含扫描版 PDF，可能是页图识别/抽取失败）');
	}

	return { material, scanRequired };
}
