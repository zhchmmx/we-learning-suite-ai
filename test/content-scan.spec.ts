import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chunkText, ContentScanError, scanCorpus, scanQuestionBatch } from "../src/services/content-scan";

// ===== 工具 =====

/** 桩全局 fetch（Waffo 扫描是外呼，走全局 fetch） */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			return handler(url, init);
		},
	);
}

function scanEnv(overrides: Record<string, unknown> = {}): Env {
	return {
		...env,
		WAFFO_MERCHANT_ID: "MER_TEST",
		WAFFO_PRIVATE_KEY: TEST_PRIVATE_KEY_B64,
		WAFFO_SCAN_BASE_URL: "https://api.waffo.ai",
		CONTENT_SCAN_ENABLED: "true",
		SCAN_MAX_CHARS: "9000",
		SCAN_CONCURRENCY: "4",
		SCAN_TIMEOUT_MS: "15000",
		...overrides,
	} as unknown as Env;
}

function verdictResponse(action: string, extra: Record<string, unknown> = {}): Response {
	return new Response(
		JSON.stringify({
			data: {
				action,
				reasonCode: action === "allow" ? "allowed" : action === "block" ? "restricted_content" : "review_required",
				matchedCategories: action === "block" ? ["test_category"] : [],
				requestId: "req_test_1",
				...extra,
			},
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

// ===== 测试用 RSA 密钥对（PKCS#8 私钥导出为裸 Base64，模拟商户私钥形态）=====

let TEST_PRIVATE_KEY_B64 = "";
let testPublicKey: CryptoKey;

beforeAll(async () => {
	const keyPair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
	const bytes = new Uint8Array(pkcs8);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	TEST_PRIVATE_KEY_B64 = btoa(binary);
	testPublicKey = keyPair.publicKey;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function bytesToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

// ===== chunkText =====

describe("chunkText", () => {
	it("短文本不切分", () => {
		expect(chunkText("hello", 100)).toEqual(["hello"]);
		expect(chunkText("", 100)).toEqual([]);
	});

	it("恰好在边界长度不切分，超 1 字符切两块", () => {
		const exact = "a".repeat(50);
		expect(chunkText(exact, 50)).toEqual([exact]);
		const over = "a".repeat(51);
		const chunks = chunkText(over, 50);
		expect(chunks).toHaveLength(2);
		expect(chunks.join("")).toBe(over);
	});

	it("优先在段落边界切分", () => {
		const text = "a".repeat(60) + "\n\n" + "b".repeat(60);
		const chunks = chunkText(text, 80);
		expect(chunks.length).toBe(2);
		expect(chunks[0]).toBe("a".repeat(60) + "\n\n");
		expect(chunks[1]).toBe("b".repeat(60));
	});

	it("无边界长文硬切，每块不超限且无内容丢失", () => {
		const text = "x".repeat(250);
		const chunks = chunkText(text, 100);
		expect(chunks).toHaveLength(3);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
		expect(chunks.join("")).toBe(text);
	});

	it("120K 语料分块数符合预期", () => {
		const text = "y".repeat(120_000);
		const chunks = chunkText(text, 9000);
		expect(chunks).toHaveLength(Math.ceil(120_000 / 9000));
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(9000);
	});
});

// ===== 签名 =====

describe("请求签名", () => {
	it("携带正确的商户 ID / 时间戳 / 可验证的 RSA-SHA256 签名，且 body hash 一致", async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		stubFetch((url, init) => {
			captured = { url, init: init ?? {} };
			return verdictResponse("allow");
		});

		await scanCorpus(scanEnv(), "正常学习材料", "sess_sig");

		expect(captured).not.toBeNull();
		const { url, init } = captured!;
		expect(url).toBe("https://api.waffo.ai/v1/actions/verification/scan-prompt");

		const headers = init.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["X-Merchant-Id"]).toBe("MER_TEST");
		expect(headers["X-Timestamp"]).toMatch(/^\d+$/);

		// body 是定稿后的 JSON，prompt 为原文
		const body = init.body as string;
		expect(JSON.parse(body)).toEqual({ prompt: "正常学习材料" });

		// bodyHash = base64(sha256(body))
		const expectHash = bytesToBase64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
		const canonical = `POST\n/v1/actions/verification/scan-prompt\n${headers["X-Timestamp"]}\n${expectHash}`;

		// 用测试公钥验证签名
		const sigBytes = Uint8Array.from(atob(headers["X-Signature"]), (c) => c.charCodeAt(0));
		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			testPublicKey,
			sigBytes,
			new TextEncoder().encode(canonical),
		);
		expect(ok).toBe(true);
	});
});

// ===== 判定映射 =====

describe("判定映射", () => {
	it("allow 静默通过", async () => {
		stubFetch(() => verdictResponse("allow"));
		await expect(scanCorpus(scanEnv(), "正常材料", "sess_ok")).resolves.toBeUndefined();
	});

	it("block 抛 CONTENT_BLOCKED", async () => {
		stubFetch(() => verdictResponse("block"));
		await expect(scanCorpus(scanEnv(), "违规材料", "sess_blk")).rejects.toMatchObject({
			name: "ContentScanError",
			reasonCode: "CONTENT_BLOCKED",
		});
	});

	it("4xx 不重试，fail-closed 归为 CONTENT_SCAN_UNAVAILABLE", async () => {
		let calls = 0;
		stubFetch(() => {
			calls++;
			return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401 });
		});
		await expect(scanCorpus(scanEnv(), "材料", "sess_4xx")).rejects.toMatchObject({
			reasonCode: "CONTENT_SCAN_UNAVAILABLE",
		});
		expect(calls).toBe(1);
	});

	it("5xx 退避重试 3 次后 fail-closed（共 4 次请求）", async () => {
		vi.useFakeTimers();
		let calls = 0;
		stubFetch(() => {
			calls++;
			return new Response("bad gateway", { status: 502 });
		});

		const promise = scanCorpus(scanEnv(), "材料", "sess_5xx");
		// 先挂断言（注册 rejection handler），再推进退避阶梯 5s + 10s + 20s
		const assertion = expect(promise).rejects.toMatchObject({ reasonCode: "CONTENT_SCAN_UNAVAILABLE" });
		await vi.advanceTimersByTimeAsync(40_000);
		await assertion;
		expect(calls).toBe(4);
	});

	it("review 重扫 3 次仍未决 → CONTENT_REVIEW_PENDING（共 4 次请求）", async () => {
		vi.useFakeTimers();
		let calls = 0;
		stubFetch(() => {
			calls++;
			return verdictResponse("review", { reasonCode: "service_degraded" });
		});

		const promise = scanCorpus(scanEnv(), "材料", "sess_rvw");
		// 先挂断言，再推进重扫阶梯 5s + 15s + 45s
		const assertion = expect(promise).rejects.toMatchObject({ reasonCode: "CONTENT_REVIEW_PENDING" });
		await vi.advanceTimersByTimeAsync(70_000);
		await assertion;
		expect(calls).toBe(4);
	});

	it("review 一次后转 allow → 通过", async () => {
		vi.useFakeTimers();
		let calls = 0;
		stubFetch(() => {
			calls++;
			return calls === 1 ? verdictResponse("review") : verdictResponse("allow");
		});

		const promise = scanCorpus(scanEnv(), "材料", "sess_rvw_ok");
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(promise).resolves.toBeUndefined();
		expect(calls).toBe(2);
	});
});

// ===== 开关与入口行为 =====

describe("开关与入口", () => {
	it("CONTENT_SCAN_ENABLED 非 true 时零外呼", async () => {
		let calls = 0;
		stubFetch(() => {
			calls++;
			return verdictResponse("allow");
		});
		await scanCorpus(scanEnv({ CONTENT_SCAN_ENABLED: "false" }), "材料", "sess_off");
		await scanQuestionBatch(
			scanEnv({ CONTENT_SCAN_ENABLED: undefined as unknown as string }),
			[{ type: "true_false", content: { stem: "1+1=2" }, answer: { correct: true } }],
			"sess_off",
			1,
		);
		expect(calls).toBe(0);
	});

	it("输出侧整批 JSON 超限时降级逐题扫描", async () => {
		const prompts: string[] = [];
		stubFetch((_url, init) => {
			prompts.push(JSON.parse((init?.body as string) ?? "{}").prompt);
			return verdictResponse("allow");
		});

		// SCAN_MAX_CHARS=200：3 道题整批 JSON 必超 200，逐题后单题 < 200
		const questions = [1, 2, 3].map((n) => ({
			type: "true_false",
			content: { stem: `题目${n}：${"内容".repeat(20)}` },
			answer: { correct: n % 2 === 0 },
		}));
		await scanQuestionBatch(scanEnv({ SCAN_MAX_CHARS: "200" }), questions, "sess_out", 2);

		expect(prompts).toHaveLength(3);
		// 每次请求都是单题 JSON（含 type/content/answer），而非整批
		for (const p of prompts) expect(p).toContain('"type":"true_false"');
	});

	it("输出侧空批次直接跳过", async () => {
		let calls = 0;
		stubFetch(() => {
			calls++;
			return verdictResponse("allow");
		});
		await scanQuestionBatch(scanEnv(), [], "sess_empty", 1);
		expect(calls).toBe(0);
	});

	it("ContentScanError 携带 reasonCode 且是 Error 实例", () => {
		const err = new ContentScanError("CONTENT_BLOCKED", "test");
		expect(err).toBeInstanceOf(Error);
		expect(err.reasonCode).toBe("CONTENT_BLOCKED");
		expect(err.name).toBe("ContentScanError");
	});
});
