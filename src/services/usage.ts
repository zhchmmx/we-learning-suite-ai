/**
 * 用户月度用量：按 user_id 元数据过滤 AI Gateway 日志并聚合。
 *
 * 数据源是 Cloudflare Logs API（api.cloudflare.com 账号级接口，鉴权复用
 * 网关访问令牌 CF_AIG_TOKEN），每条日志含 cost / tokens_in / tokens_out，
 * 分页拉取后本地求和。"月"为北京时间（UTC+8）自然月。
 */

/** 月度用量聚合结果（GET /api/usage 的 data 字段契约） */
export interface MonthlyUsage {
	/** 查询月份（回显，YYYY-MM） */
	month: string;
	/** 该月模型调用次数（规划 + 分批生成 + OCR 全部计入） */
	requests: number;
	/** 该月费用合计（USD，网关按美元计价） */
	cost: number;
	/** 输入 token 合计 */
	tokensIn: number;
	/** 输出 token 合计 */
	tokensOut: number;
}

const PER_PAGE = 50;
/** 翻页上限：40 页 × 100 条 = 4000 条；正常量级远达不到，防失控兜底 */
const MAX_PAGES = 40;
/** 单页请求超时 */
const PAGE_TIMEOUT_MS = 15_000;

/** Logs API 响应（只声明聚合需要的字段） */
interface LogsApiResponse {
	success: boolean;
	result?: Array<{ cost?: number | null; tokens_in?: number | null; tokens_out?: number | null }>;
	result_info?: { total_count?: number };
}

/** 当前北京时间（UTC+8）月份，格式 YYYY-MM */
export function currentBeijingMonth(): string {
	return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
}

/** 校验 ym：YYYY-MM 格式，且不得晚于当前月（未来月无数据） */
export function isValidYm(ym: string): boolean {
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return false;
	return ym <= currentBeijingMonth();
}

/** 北京时间自然月范围：[该月 1 号 00:00, 次月 1 号 00:00 - 1ms] */
function monthRange(ym: string): { start: Date; end: Date } {
	const [y, m] = ym.split('-').map(Number);
	const nextY = m === 12 ? y + 1 : y;
	const nextM = m === 12 ? '01' : String(m + 1).padStart(2, '0');
	const nextStart = Date.parse(`${nextY}-${nextM}-01T00:00:00+08:00`);
	return {
		start: new Date(Date.parse(`${ym}-01T00:00:00+08:00`)),
		end: new Date(nextStart - 1),
	};
}

/**
 * 拉取并聚合某用户某月的 AI Gateway 用量。
 * 失败时抛 Error（message 含 Logs API 状态码 / 原因），由调用方转 502。
 */
export async function fetchMonthlyUsage(opts: {
	authToken: string;
	accountId: string;
	gatewayId: string;
	userId: string;
	ym: string;
}): Promise<MonthlyUsage> {
	const { authToken, accountId, gatewayId, userId, ym } = opts;
	const { start, end } = monthRange(ym);

	const url = new URL(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways/${gatewayId}/logs`,
	);
	url.searchParams.set(
		'filters',
		JSON.stringify([
			{ key: 'metadata.key', operator: 'eq', value: ['user_id'] },
			{ key: 'metadata.value', operator: 'eq', value: [userId] },
		]),
	);
	url.searchParams.set('start_date', start.toISOString());
	url.searchParams.set('end_date', end.toISOString());
	url.searchParams.set('per_page', String(PER_PAGE));
	url.searchParams.set('order_by', 'created_at');
	url.searchParams.set('order_by_direction', 'asc');

	let requests = 0;
	let cost = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let fetched = 0;

	for (let page = 1; page <= MAX_PAGES; page++) {
		url.searchParams.set('page', String(page));

		let res: Response;
		try {
			res = await fetch(url, {
				headers: { Authorization: `Bearer ${authToken}` },
				signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
			});
		} catch (err) {
			throw new Error(`Logs API request failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(`Logs API HTTP ${res.status}: ${detail.slice(0, 300)}`);
		}

		const body = (await res.json()) as LogsApiResponse;
		const logs = body.result ?? [];
		for (const log of logs) {
			requests++;
			cost += log.cost ?? 0;
			tokensIn += log.tokens_in ?? 0;
			tokensOut += log.tokens_out ?? 0;
		}
		fetched += logs.length;

		// 空页或取满 total_count → 结束翻页
		const total = body.result_info?.total_count;
		if (logs.length === 0 || (total !== undefined && fetched >= total)) break;
	}

	// cost 是浮点累加，取 6 位小数消除尾差
	return { month: ym, requests, cost: Math.round(cost * 1e6) / 1e6, tokensIn, tokensOut };
}
