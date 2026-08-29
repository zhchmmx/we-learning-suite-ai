import { MAX_IMAGE_BYTES, MIN_SCAN_IMAGE_BYTES } from '../config';

/**
 * 扫描件 PDF 内存扫描器：定位 /Subtype /Image + /DCTDecode 对象，
 * 按 /Length（间接引用时退化为有界 endstream 查找）切出内嵌 JPEG，
 * 魔数校验（FFD8FF）+ 尺寸过滤后返回副本。
 *
 * 调用方已持有完整 PDF 字节（toMarkdown 需整文件入 Blob），无需 R2 分块 Range。
 * 仅处理 DCTDecode（JPEG）编码的图片；JPXDecode/Flate 等编码的扫描件不会被提取。
 */

const MARKER = asciiBytes('/DCTDecode');
const STREAM_KW = asciiBytes('stream');
const ENDSTREAM_KW = asciiBytes('endstream');
const STREAM_SEARCH_WINDOW = 2048;
const DICT_LOOKBACK = 2048;
const LENGTH_RE = /\/Length\s+(\d+)/;
const SUBTYPE_RE = /\/Subtype\s*\/Image/;

/**
 * 从 PDF 字节中提取所有内嵌 JPEG 图片。
 * @param pdf 完整 PDF 文件字节
 * @param budget 最多提取的图片数量
 */
export function extractPdfImages(pdf: Uint8Array, budget: number): Uint8Array[] {
	const images: Uint8Array[] = [];
	if (budget <= 0 || pdf.length < 16) return images;

	let i = 0;
	while (images.length < budget) {
		const idx = indexOfBytes(pdf, MARKER, i);
		if (idx === -1) break;
		i = idx + 1;

		// 字典邻域校验：确认这是图片对象
		const winFrom = Math.max(0, idx - DICT_LOOKBACK);
		if (!SUBTYPE_RE.test(toAscii(pdf, winFrom, Math.min(pdf.length, idx + DICT_LOOKBACK)))) {
			continue;
		}

		// 在标记之后有限窗口内找 `stream` 关键字
		const streamIdx = indexOfBytes(pdf, STREAM_KW, idx + MARKER.length);
		if (streamIdx === -1 || streamIdx - idx > STREAM_SEARCH_WINDOW) continue;

		// `stream` 之后紧跟换行即为数据起点
		let dataStart = streamIdx + STREAM_KW.length;
		while (dataStart < pdf.length && (pdf[dataStart] === 0x0d || pdf[dataStart] === 0x0a)) {
			dataStart++;
		}
		if (dataStart >= pdf.length) break;

		// 流长度：优先字典里的 /Length；间接引用时退化为有界 endstream 查找
		const dictAscii = toAscii(pdf, winFrom, streamIdx);
		let dataLen: number;
		const lengthMatch = LENGTH_RE.exec(dictAscii);
		if (lengthMatch) {
			dataLen = parseInt(lengthMatch[1], 10);
		} else {
			const endRel = findEndStreamInBuffer(pdf, dataStart, MAX_IMAGE_BYTES + 0x10000);
			if (endRel === -1) continue;
			dataLen = endRel - dataStart;
		}

		if (dataLen < MIN_SCAN_IMAGE_BYTES || dataLen > MAX_IMAGE_BYTES) continue;
		if (dataStart + dataLen > pdf.length) continue;

		// JPEG 魔数校验（FFD8FF）
		if (pdf[dataStart] !== 0xff || pdf[dataStart + 1] !== 0xd8 || pdf[dataStart + 2] !== 0xff) continue;

		images.push(pdf.slice(dataStart, dataStart + dataLen));
	}

	return images;
}

/** 在缓冲区内有界查找 `endstream`，返回其起始偏移；找不到返回 -1 */
function findEndStreamInBuffer(buf: Uint8Array, from: number, maxScan: number): number {
	const end = Math.min(buf.length, from + maxScan);
	const idx = indexOfBytes(buf, ENDSTREAM_KW, from);
	if (idx === -1 || idx > end) return -1;
	return idx;
}

// ===== 字节工具 =====

function asciiBytes(s: string): Uint8Array {
	const bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
	return bytes;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
	if (needle.length === 0) return from;
	const first = needle[0];
	let i = haystack.indexOf(first, from);
	while (i !== -1) {
		if (i + needle.length <= haystack.length) {
			let ok = true;
			for (let j = 1; j < needle.length; j++) {
				if (haystack[i + j] !== needle[j]) {
					ok = false;
					break;
				}
			}
			if (ok) return i;
		}
		i = haystack.indexOf(first, i + 1);
	}
	return -1;
}

function toAscii(buf: Uint8Array, start: number, end: number): string {
	let out = '';
	for (let i = start; i < end; i++) out += String.fromCharCode(buf[i]);
	return out;
}
