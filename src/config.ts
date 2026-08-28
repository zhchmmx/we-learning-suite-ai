import type { ModelTarget } from './types';

/** 图片通道限制 */
export const MAX_IMAGES = 15;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 单张 4MB（base64 编码是 CPU 操作，免费套餐要控制量）

/** 文本通道限制（超过直接判失败，提示用户拆分） */
export const MAX_TEXT_CHARS = 120_000;

/** 出题数量 */
export const DEFAULT_QUESTION_COUNT = 5;
export const MIN_QUESTION_COUNT = 1;
export const MAX_QUESTION_COUNT = 50;

/** 每次 OCR 请求最多携带的图片数 */
export const OCR_IMAGES_PER_CALL = 5;

/** 分批生成：每批生成的题目数上限 */
export const GENERATION_BATCH_SIZE = 15;

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

/** 文档通道：AI.toMarkdown 支持的格式（PDF 单独处理——转不出文字时按扫描件兜底） */
export const DOC_TO_MARKDOWN_MIME_TYPES = new Set([
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
	'application/vnd.ms-excel', // xls
	'application/vnd.oasis.opendocument.text', // odt
	'application/vnd.oasis.opendocument.spreadsheet', // ods
	'text/html',
	'application/xml',
	'text/csv',
]);

/** MIME → 扩展名：AI.toMarkdown 按文件名扩展名解析，而 R2 key 是无扩展名 UUID，需要映射构造 name */
export const MIME_TO_EXTENSION: Record<string, string> = {
	'application/pdf': 'pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
	'application/vnd.ms-excel': 'xls',
	'application/vnd.oasis.opendocument.text': 'odt',
	'application/vnd.oasis.opendocument.spreadsheet': 'ods',
	'text/html': 'html',
	'application/xml': 'xml',
	'text/csv': 'csv',
};

/** 进入 AI.toMarkdown 的文档体积上限（内存护栏：Worker 内整块 arrayBuffer，免费额度 128MB/隔离） */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** 扫描件检测：toMarkdown 输出的非空白字符低于该值即判定为扫描件（toMarkdown 无页面级 OCR） */
export const SCAN_MIN_CHARS = 100;

/** 扫描件分块扫描：最多抽取的页图数量（与 MAX_IMAGES 对齐） */
export const MAX_SCAN_PAGES = 15;

/** 扫描件分块扫描：每轮 alarm 读取的块大小（免费额度 10ms CPU/次，单块扫描成本需落在预算内） */
export const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** 扫描件分块扫描：块尾保留字节数，防止标记横跨块边界漏检 */
export const SCAN_CARRY_BYTES = 4 * 1024;

/** 扫描件分块扫描：临时页图的 R2 前缀（建议配置 1 天过期的生命周期规则兜底） */
export const SCAN_TMP_PREFIX = 'tmp/scan';

/** 扫描件分块扫描：小于该尺寸的图视为 logo/图标，丢弃 */
export const MIN_SCAN_IMAGE_BYTES = 10 * 1024;

