import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

// GET /api/usage：按 user_id 元数据过滤 AI Gateway 日志并聚合月度用量。
// 纯 fetch + 聚合逻辑（无 DO / R2），本机可直接运行。

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		return handler(url, init);
	});
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeEnv(overrides: Record<string, unknown>): Env {
	return { ...env, ...overrides } as unknown as Env;
}

// 用量端点只依赖这三个 env 字段（AI_GATEWAY_ID 来自 wrangler vars，另两个注入）
const USAGE_ENV = { CF_ACCOUNT_ID: "acct-1", CF_AIG_TOKEN: "tok-1" };

async function getUsage(query: string, customEnv: Env) {
	const request = new IncomingRequest(`http://example.com/api/usage${query}`);
	const ctx = createExecutionContext();
	return worker.fetch(request, customEnv, ctx);
}

/** Logs API 单页响应 */
function logsPage(logs: Array<{ cost?: number; tokens_in?: number; tokens_out?: number }>, totalCount: number) {
	return jsonResponse({ success: true, result: logs, result_info: { total_count: totalCount } });
}

describe("GET /api/usage", () => {
	beforeEach(() => {
		// 默认拒绝一切未配置的外呼
		stubFetch((url) => new Response(`unexpected fetch: ${url}`, { status: 599 }));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("rejects missing userId with 400", async () => {
		const response = await getUsage("", makeEnv(USAGE_ENV));
		expect(response.status).toBe(400);
	});

	it("rejects invalid ym format with 400", async () => {
		for (const ym of ["2026-13", "abc", "2026-8", "202608"]) {
			const response = await getUsage(`?userId=u-1&ym=${ym}`, makeEnv(USAGE_ENV));
			expect(response.status, `ym=${ym}`).toBe(400);
		}
	});

	it("rejects future ym with 400", async () => {
		const response = await getUsage("?userId=u-1&ym=2999-01", makeEnv(USAGE_ENV));
		expect(response.status).toBe(400);
	});

	it("aggregates cost/tokens/requests across pages with correct filters and month range", async () => {
		const seen: string[] = [];
		stubFetch((urlStr) => {
			const url = new URL(urlStr);
			if (!url.pathname.endsWith("/logs")) {
				return new Response(`unexpected: ${urlStr}`, { status: 599 });
			}
			seen.push(urlStr);
			// 第一页 2 条（total 3），第二页 1 条
			if (url.searchParams.get("page") === "1") {
				return logsPage(
					[
						{ cost: 0.1, tokens_in: 100, tokens_out: 50 },
						{ cost: 0.05, tokens_in: 30, tokens_out: 20 },
					],
					3,
				);
			}
			return logsPage([{ cost: 0.2, tokens_in: 10, tokens_out: 5 }], 3);
		});

		const response = await getUsage("?userId=u-1&ym=2026-07", makeEnv(USAGE_ENV));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: unknown };
		// cost 0.1+0.05+0.2 浮点累加有尾差，验证已按 6 位小数收敛
		expect(body.data).toEqual({
			month: "2026-07",
			requests: 3,
			cost: 0.35,
			tokensIn: 140,
			tokensOut: 75,
		});

		// 请求参数：按 user_id 元数据过滤 + 北京时间自然月边界（2026-07 即 UTC 6/30 16:00 起）
		expect(seen).toHaveLength(2);
		const first = new URL(seen[0]);
		expect(first.searchParams.get("filters")).toBe(
			JSON.stringify([
				{ key: "metadata.key", operator: "eq", value: ["user_id"] },
				{ key: "metadata.value", operator: "eq", value: ["u-1"] },
			]),
		);
		expect(first.searchParams.get("start_date")).toBe("2026-06-30T16:00:00.000Z");
		expect(first.searchParams.get("end_date")).toBe("2026-07-31T15:59:59.999Z");
	});

	it("returns 502 when the Logs API rejects authentication", async () => {
		stubFetch(() => jsonResponse({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401));
		const response = await getUsage("?userId=u-1", makeEnv(USAGE_ENV));
		expect(response.status).toBe(502);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("用量服务暂时不可用");
	});

	it("treats missing/null cost and tokens as zero", async () => {
		stubFetch(() =>
			logsPage([{ cost: null, tokens_in: null, tokens_out: null }, { cost: 0.01, tokens_in: 5 }], 2),
		);
		const response = await getUsage("?userId=u-1&ym=2026-07", makeEnv(USAGE_ENV));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: unknown };
		expect(body.data).toEqual({ month: "2026-07", requests: 2, cost: 0.01, tokensIn: 5, tokensOut: 0 });
	});
});
