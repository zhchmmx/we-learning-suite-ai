import {
	MAX_IMAGE_BYTES,
	MIN_SCAN_IMAGE_BYTES,
	SCAN_CARRY_BYTES,
	SCAN_CHUNK_BYTES,
	SCAN_TMP_PREFIX,
} from '../config';
import { TaskError } from './extract';

/**
 * 扫描件 PDF 分块扫描器（免费版 Worker 友好）。
 *
 * 扫描件 PDF 内嵌每页的 JPEG（DCTDecode）。这里不做任何渲染/解码：
 * 每轮 alarm 只用 R2 Range 读一个块（SCAN_CHUNK_BYTES），在块内定位
 * `/Subtype /Image` + `/DCTDecode` 标记，解析 `/Length`（间接引用时
 * 退化为有界的 endstream 查找），再精确 Range 读出完整 JPEG 流，
 * 校验魔数后写入临时 R2 前缀。偏移量与 carry 持久化在 DO，
 * 跨多轮 alarm 续扫，直到抽够页数或扫到文件尾。
 *
 * 堆内永远只有"一块 + 一张图"，任意大小的 PDF 都安全。
 */

const MARKER = asciiBytes('/DCTDecode');
const STREAM_KW = asciiBytes('stream');
const ENDSTREAM_KW = asciiBytes('endstream');
const STREAM_SEARCH_WINDOW = 2048; // 标记之后多长范围内找 `stream` 关键字
const DICT_LOOKBACK = 2048; // 标记之前多长范围内找 /Subtype /Image 与 /Length
const LENGTH_RE = /\/Length\s+(\d+)/;
const SUBTYPE_RE = /\/Subtype\s*\/Image/;

/** 扫描会话状态（随 TaskState 持久化到 DO storage，跨 alarm 续扫） */
export interface ScanSession {
	targets: Array<{ r2Key: string; size: number }>;
	targetIndex: number;
	/** 当前 target 下一块的读取起点 */
	offset: number;
	/** 上一块尾部字节的 base64（防标记横跨块边界漏检） */
	carry: string;
	/** 剩余可抽取图片配额 */
	budget: number;
	/** 临时文件自增序号 */
	seq: number;
}

export interface ScanRoundResult {
	session: ScanSession;
	/** 本轮抽出并已写入临时 R2 的对象 key */
	extractedKeys: string[];
	/** 全部 target 扫描完毕或配额用尽 */
	done: boolean;
}

export function createScanSession(
	targets: Array<{ r2Key: string; size: number }>,
	budget: number,
): ScanSession {
	return { targets, targetIndex: 0, offset: 0, carry: '', budget, seq: 0 };
}

/**
 * 执行一轮扫描：只处理当前 target 的一个块，然后返回（由 DO 决定是否续排下一轮）。
 */
export async function runScanRound(
	bucket: R2Bucket,
	userId: string,
	ticket: string,
	input: ScanSession,
): Promise<ScanRoundResult> {
	const session: ScanSession = { ...input };
	const extractedKeys: string[] = [];

	while (session.targetIndex < session.targets.length) {
		const target = session.targets[session.targetIndex];

		if (session.budget <= 0 || session.offset >= target.size) {
			session.targetIndex++;
			session.offset = 0;
			session.carry = '';
			continue;
		}

		// 读一个块（I/O，不耗 CPU 预算）
		const carryBytes = base64ToBytes(session.carry);
		const readStart = session.offset;
		const chunkLen = Math.min(SCAN_CHUNK_BYTES, target.size - readStart);
		const chunkObj = await bucket.get(target.r2Key, {
			range: { offset: readStart, length: chunkLen },
		});
		if (!chunkObj) {
			throw new TaskError(`扫描中断：文件不存在或不可读（R2 key=${target.r2Key}）`);
		}
		const chunk = new Uint8Array(await chunkObj.arrayBuffer());

		// 拼接 carry，块间标记不漏检
		const buf = new Uint8Array(carryBytes.length + chunk.length);
		buf.set(carryBytes);
		buf.set(chunk, carryBytes.length);
		const base = readStart - carryBytes.length; // buf[0] 对应的绝对偏移

		let i = 0;
		let rewound = false;
		while (session.budget > 0) {
			const idx = indexOfBytes(buf, MARKER, i);
			if (idx === -1) break;
			i = idx + 1;

			const abs = base + idx;
			// 完全落在本轮读取起点之前的标记，上一轮已经完整可见并处理过
			if (abs + MARKER.length <= readStart) continue;

			// 字典邻域校验：确认这是图片对象而不是内容流里的巧合字符串
			const winFrom = Math.max(0, idx - DICT_LOOKBACK);
			if (!SUBTYPE_RE.test(toAscii(buf, winFrom, Math.min(buf.length, idx + DICT_LOOKBACK)))) {
				continue;
			}

			// 在标记之后有限窗口内找 `stream` 关键字
			const streamIdx = indexOfBytes(buf, STREAM_KW, idx + MARKER.length);
			if (streamIdx === -1 || streamIdx - idx > STREAM_SEARCH_WINDOW) {
				// 窗口被块边界截断：回卷到标记位置，下一轮从这里续扫
				session.offset = abs;
				session.carry = '';
				rewound = true;
				break;
			}

			// `stream` 之后紧跟一个换行即为数据起点
			let dataStart = streamIdx + STREAM_KW.length;
			while (dataStart < buf.length && (buf[dataStart] === 0x0d || buf[dataStart] === 0x0a)) {
				dataStart++;
			}
			if (dataStart >= buf.length) {
				session.offset = abs;
				session.carry = '';
				rewound = true;
				break;
			}
			const dataStartAbs = base + dataStart;

			// 流长度：优先字典里的 /Length；间接引用时退化为有界 endstream 查找
			const dictAscii = toAscii(buf, winFrom, streamIdx);
			let dataLen: number;
			const lengthMatch = LENGTH_RE.exec(dictAscii);
			if (lengthMatch) {
				dataLen = parseInt(lengthMatch[1], 10);
			} else {
				const endAbs = await findEndStream(bucket, target.r2Key, dataStartAbs, MAX_IMAGE_BYTES + 0x10000);
				if (endAbs === null) continue; // 找不到就放弃这个匹配
				dataLen = endAbs - dataStartAbs;
			}

			if (dataLen < MIN_SCAN_IMAGE_BYTES || dataLen > MAX_IMAGE_BYTES) continue;

			// 精确 Range 读整张图（I/O）
			const imgObj = await bucket.get(target.r2Key, {
				range: { offset: dataStartAbs, length: dataLen },
			});
			if (!imgObj) continue;
			const img = new Uint8Array(await imgObj.arrayBuffer());

			// JPEG 魔数校验（FFD8FF），过滤误匹配
			if (img.length < 3 || img[0] !== 0xff || img[1] !== 0xd8 || img[2] !== 0xff) continue;

			session.seq++;
			const key = `${userId}/${SCAN_TMP_PREFIX}/${ticket}/p${session.seq}.jpg`;
			await bucket.put(key, img, { httpMetadata: { contentType: 'image/jpeg' } });
			extractedKeys.push(key);
			session.budget--;
		}

		if (rewound) {
			return { session, extractedKeys, done: false };
		}

		// 本块扫完：推进偏移，保留尾部 carry；短读（读到文件尾）直接结束当前 target
		session.offset = readStart + chunk.length;
		session.carry = bytesToBase64(buf.subarray(Math.max(0, buf.length - SCAN_CARRY_BYTES)));
		if (session.offset >= target.size || chunk.length < chunkLen) {
			session.targetIndex++;
			session.offset = 0;
			session.carry = '';
		}

		return {
			session,
			extractedKeys,
			done: session.budget <= 0 || session.targetIndex >= session.targets.length,
		};
	}

	return { session, extractedKeys, done: true };
}

/** /Length 为间接引用时的兜底：从数据起点向后有界查找 `endstream`，返回其绝对偏移 */
async function findEndStream(
	bucket: R2Bucket,
	r2Key: string,
	fromAbs: number,
	maxScan: number,
): Promise<number | null> {
	let offset = fromAbs;
	let prevTail = new Uint8Array(ENDSTREAM_KW.length - 1);
	let scanned = 0;

	while (scanned < maxScan) {
		const len = Math.min(SCAN_CHUNK_BYTES, maxScan - scanned);
		const obj = await bucket.get(r2Key, { range: { offset, length: len } });
		if (!obj) return null;
		const chunk = new Uint8Array(await obj.arrayBuffer());
		if (chunk.length === 0) return null;

		const buf = new Uint8Array(prevTail.length + chunk.length);
		buf.set(prevTail);
		buf.set(chunk, prevTail.length);

		const hit = indexOfBytes(buf, ENDSTREAM_KW, 0);
		if (hit !== -1) {
			return offset - prevTail.length + hit;
		}

		prevTail = buf.subarray(Math.max(0, buf.length - (ENDSTREAM_KW.length - 1)));
		offset += chunk.length;
		scanned += chunk.length;
		if (chunk.length < len) return null; // 文件到尾了
	}
	return null;
}

// ===== 字节工具 =====

function asciiBytes(s: string): Uint8Array {
	const bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
	return bytes;
}

/** 在 haystack 中查找 needle（TypedArray.indexOf 不支持子数组，自行实现） */
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

/** 小窗口字节转 ASCII 文本（仅用于字典匹配，非语料路径） */
function toAscii(buf: Uint8Array, start: number, end: number): string {
	let out = '';
	for (let i = start; i < end; i++) out += String.fromCharCode(buf[i]);
	return out;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	if (!b64) return new Uint8Array(0);
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
