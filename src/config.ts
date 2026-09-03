import type { ModelTarget } from './types';

/** 图片通道限制 */
export const MAX_IMAGES = 15;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 单张 4MB（base64 编码是 CPU 操作，免费套餐要控制量）

/** 文本通道限制（超过直接判失败，提示用户拆分） */
export const MAX_TEXT_CHARS = 120_000;

/** 出题数量 */
export const DEFAULT_QUESTION_COUNT = 5;
export const MIN_QUESTION_COUNT = 1;
/** 每个文件（每次生成任务 / 每个 Quiz）的题目总数上限（用户拍板：400 题已稳定运行） */
export const MAX_QUESTION_COUNT = 1000;

/** 每次 OCR 请求最多携带的图片数 */
export const OCR_IMAGES_PER_CALL = 5;

/** 分批生成：每批生成的题目数上限 */
export const GENERATION_BATCH_SIZE = 15;

/**
 * 上传分片：每次 HTTP 请求携带的题目数。
 * ≤500 满足 API MAX_BATCH_SIZE。题目本体在 DO 里按批分键（q_<batchIndex>），
 * 上传时流式攒片发送；100 题/片让 uploadedCount 断点粒度更细，失败重传代价更小。
 * 题目总数 >100 时分片全部上传，严禁截断。
 */
export const UPLOAD_CHUNK_SIZE = 100;

/** 同一阶段失败自动重试次数（LLM 抖动/网络/5xx），超过才置 failed。1000 题 ≈ 67 批，单批失败率会累积，必须自动重试 */
export const PHASE_AUTO_RETRIES = 2;

/** 计数驱动循环防死循环：连续 N 批 0 合格题目 → 判失败 */
export const MAX_EMPTY_BATCH_STREAK = 3;

/** allStems 滚动窗口：跨批去重用，同时控制 prompt 膨胀 */
export const STEM_WINDOW = 150;

/**
 * 终态任务的 DO storage 保留时长：
 * - failed：保留断点现场（corpus、已生成批次）供断点续传，到期由 alarm 兜底清空
 * - done：仅兜底清理（corpus 已在完成时立即释放）
 */
export const FAILED_TASK_RETENTION_MS = 48 * 60 * 60 * 1000;
export const DONE_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 模型调用 max_tokens：规划阶段（输出很小） */
export const PLAN_MAX_TOKENS = 4_000;

/** thinking 模型的规划阶段 max_tokens（思维链+答案一起算，需要更大空间） */
export const PLAN_THINKING_MAX_TOKENS = 32_000;

/** 模型调用 max_tokens：分批生成阶段（每批最多 15 道题，需要足够空间输出完整 JSON） */
export const GENERATION_MAX_TOKENS = 16_000;

/** 流式接收：最后一个 chunk 到达后，若超过此时间仍无新 chunk 则视为连接挂死，中止请求 */
export const CHUNK_IDLE_TIMEOUT_MS = 30_000;

/**
 * 直连模型链（USE_DIRECT_MODELS="true" 时生效）：主选不可用依次降级。
 * 不加退避等待、不对同一模型重试——网关侧已配置指数退避。
 * provider 段进请求 URL（gateway.getUrl(provider)），model 为裸名进请求体；
 * plan 与 generate 分开定义，便于以后独立调整。
 */
export const PLAN_MODEL_CHAIN: readonly ModelTarget[] = [
	{ provider: 'custom-dlut', model: 'Qwen3.5-122B-A10B' },
	{ provider: 'custom-mimo', model: 'mimo-v2.5-pro' },
	{ provider: 'deepseek', model: 'deepseek-v4-flash' },
];

/** generate 模型链（当前与 plan 相同，可独立修改） */
export const GENERATE_MODEL_CHAIN: readonly ModelTarget[] = [
	{ provider: 'custom-dlut', model: 'Qwen3.5-122B-A10B' },
	{ provider: 'custom-mimo', model: 'mimo-v2.5-pro' },
	{ provider: 'deepseek', model: 'deepseek-v4-flash' },
];

/** OCR 模型链 */
export const OCR_MODEL_CHAIN: readonly ModelTarget[] = [
	{ provider: 'custom-dlut', model: 'PaddleOCR-VL-1.5' },
	{ provider: 'custom-mimo', model: 'mimo-v2.5' },
];
export const API_CALLBACK_TIMEOUT_MS = 15_000;

/** 受理端点校验 body 时材料的数量上限 */
export const MAX_MATERIALS = 50;

/** 支持的 MIME 类型 → 通道 */
export const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);
export const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** 文档通道：MIME → toMarkdown 转换所需的扩展名（name 必须带扩展名供服务识别格式） */
export const DOCUMENT_MIME_TO_EXTENSION: ReadonlyMap<string, string> = new Map([
	['application/pdf', '.pdf'],
	['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
	['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
]);

/** 单个文档大小上限（转换前用 R2Object.size 检查，保护堆内存与转换服务） */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** PDF toMarkdown 产出少于此（去空白后字符数）视为扫描件，尝试抽图 OCR */
export const SCANNED_PDF_THRESHOLD_CHARS = 200;
export const SCANNED_PDF_STRIP_THRESHOLD_CHARS = 100; // 剥壳后正文阈值：纯扫描件 toMarkdown 只留模板壳，剥掉后正文极少

/** 扫描件抽取：小于此字节的 JPEG 视为缩略图/误匹配，丢弃 */
export const MIN_SCAN_IMAGE_BYTES = 20 * 1024;

/** 扫描件分块扫描：每轮 alarm 从 R2 读取的块大小（免费 10ms CPU 预算内，单块 indexOf+窗口校验 <10ms） */
export const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/** 扫描件分块扫描：块尾保留字节数（防 /DCTDecode 等标记横跨块边界漏检） */
export const SCAN_CARRY_BYTES = 4 * 1024;
/** 扫描件分块扫描：单轮 OCR 批次 base64 累计上限（保险丝：单页图再大也只单独走一轮，防止 base64 CPU 超预算） */
export const OCR_BATCH_BASE64_BUDGET = 1 * 1024 * 1024;

