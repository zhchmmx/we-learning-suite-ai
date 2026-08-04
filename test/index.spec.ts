import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProviders } from "../src/config";
import { parseModelJson, validateQuestions } from "../src/services/generate";
import { walkProviderChain } from "../src/services/providers";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// ===== 工具 =====

/** 桩全局 fetch（模型 API 调用等非 Service Binding 的外呼） */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			return handler(url, init);
		},
	);
}

/** 构造模拟 Service Binding Fetcher（AI→API 回调走此路径，不再经过全局 fetch） */
function makeApiWorker(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): Fetcher {
	return {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			return handler(url, init);
		},
	} as unknown as Fetcher;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** 构造带自定义绑定的测试 env（替换 Service Binding 与队列绑定，注入提供商密钥） */
function makeEnv(overrides: Record<string, unknown>): Env {
	return { ...env, ...overrides } as unknown as Env;
}

const VALID_QUESTIONS_JSON = JSON.stringify({
	questions: [
		{
			type: "single_choice",
			content: { stem: "2+2等于?", options: ["3", "4", "5"] },
			answer: { correctIndex: 1 },
			tags: ["数学"],
		},
		{
			type: "true_false",
			content: { stem: "地球是平的" },
			answer: { correct: false },
		},
	],
});

beforeEach(() => {
	// 默认拒绝一切未配置的外呼，避免测试误触真实网络
	stubFetch((url) => new Response(`unexpected fetch: ${url}`, { status: 599 }));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ===== 健康检查 =====

describe("GET /health", () => {
	it("returns ok without auth", async () => {
		const request = new IncomingRequest("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string };
		expect(body.status).toBe("ok");
	});
});

// ===== 受理端点 =====

describe("POST /api/quiz/generate", () => {
	/** 不做 API 回调的测试用：提供一个拒绝一切调用的 mock Fetcher */
	const rejectAllApiWorker = makeApiWorker((url) =>
		new Response(`unexpected API call: ${url}`, { status: 599 }),
	);

	async function postGenerate(body: unknown, customEnv: Env) {
		const request = new IncomingRequest("http://example.com/api/quiz/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const ctx = createExecutionContext();
		return worker.fetch(request, customEnv, ctx);
	}

	it("rejects missing ticket with 400", async () => {
		const send = vi.fn();
		const response = await postGenerate(
			{ materials: [{ r2Key: "a.txt", mimeType: "text/plain" }] },
			makeEnv({ API_WORKER: rejectAllApiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects invalid materials with 400", async () => {
		const send = vi.fn();
		const response = await postGenerate(
			{ ticket: "t-1", materials: [] },
			makeEnv({ API_WORKER: rejectAllApiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects out-of-range count with 400", async () => {
		const send = vi.fn();
		const response = await postGenerate(
			{ ticket: "t-1", materials: [{ r2Key: "a.txt", mimeType: "text/plain" }], options: { count: 999 } },
			makeEnv({ API_WORKER: rejectAllApiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(400);
	});

	it("returns 401 when API project rejects the ticket", async () => {
		const apiWorker = makeApiWorker((url) => {
			if (url.includes("/api/quiz/sessions/") && url.endsWith("/status")) {
				return jsonResponse({ error: "Ticket is already completed" }, 403);
			}
			return new Response("unexpected", { status: 599 });
		});

		const send = vi.fn();
		const response = await postGenerate(
			{ ticket: "t-1", materials: [{ r2Key: "a.txt", mimeType: "text/plain" }] },
			makeEnv({ API_WORKER: apiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(401);
		expect(send).not.toHaveBeenCalled();
	});

	it("accepts valid ticket: verifies, enqueues, returns 202", async () => {
		const apiWorker = makeApiWorker((url) => {
			if (url.includes("/api/quiz/sessions/") && url.endsWith("/status")) {
				return jsonResponse({ data: { status: "processing" } });
			}
			return new Response("unexpected", { status: 599 });
		});

		const send = vi.fn();
		const response = await postGenerate(
			{ ticket: "t-1", materials: [{ r2Key: "a.txt", mimeType: "text/plain" }], options: { count: 8 } },
			makeEnv({ API_WORKER: apiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(202);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({
			ticket: "t-1",
			materials: [{ r2Key: "a.txt", mimeType: "text/plain" }],
			options: { count: 8 },
		});
	});
});

// ===== OCR 端点 =====

describe("POST /api/ocr", () => {
	const OCR_PROVIDERS = JSON.stringify([
		{
			name: "main",
			priority: 1,
			baseUrl: "https://provider.test/v1",
			generateModel: "gen-m",
			ocrModel: "ocr-m",
		},
	]);

	// 一张 1x1 的假 PNG（base64）
	const FAKE_IMAGE = { data: "aGVsbG8=", mimeType: "image/png" };

	// 注：生产环境本端点无公网入口（workers_dev: false，仅 Service Binding 可达），
	// 测试直接调 worker.fetch 等价于内部调用，无需鉴权用例
	async function postOcr(body: unknown, customEnv: Env) {
		const request = new IncomingRequest("http://example.com/api/ocr", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const ctx = createExecutionContext();
		return worker.fetch(request, customEnv, ctx);
	}

	it("rejects empty images array with 400", async () => {
		const customEnv = makeEnv({ AI_PROVIDERS: OCR_PROVIDERS });
		const response = await postOcr({ images: [] }, customEnv);
		expect(response.status).toBe(400);
	});

	it("rejects unsupported mime type with 400", async () => {
		const customEnv = makeEnv({ AI_PROVIDERS: OCR_PROVIDERS });
		const response = await postOcr({ images: [{ data: "aGVsbG8=", mimeType: "image/gif" }] }, customEnv);
		expect(response.status).toBe(400);
	});

	it("returns 502 when no provider has ocrModel", async () => {
		const noOcr = JSON.stringify([
			{ name: "main", priority: 1, baseUrl: "https://provider.test/v1", generateModel: "gen-m" },
		]);
		const customEnv = makeEnv({
			AI_PROVIDERS: noOcr,
			AI_PROVIDER_KEY_MAIN: "test-key",
		});
		const response = await postOcr({ images: [FAKE_IMAGE] }, customEnv);
		expect(response.status).toBe(502);
	});

	it("happy path: calls OCR model and returns text", async () => {
		stubFetch((url) => {
			if (url.includes("/chat/completions")) {
				return jsonResponse({ choices: [{ message: { content: "转录出来的文字" } }] });
			}
			return new Response(`unexpected: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			AI_PROVIDERS: OCR_PROVIDERS,
			AI_PROVIDER_KEY_MAIN: "test-key",
		});
		const response = await postOcr({ images: [FAKE_IMAGE] }, customEnv);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { text: string } };
		expect(body.data.text).toBe("转录出来的文字");
	});

	it("returns 422 when OCR result is empty", async () => {
		stubFetch((url) => {
			if (url.includes("/chat/completions")) {
				return jsonResponse({ choices: [{ message: { content: "   " } }] });
			}
			return new Response(`unexpected: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			AI_PROVIDERS: OCR_PROVIDERS,
			AI_PROVIDER_KEY_MAIN: "test-key",
		});
		const response = await postOcr({ images: [FAKE_IMAGE] }, customEnv);
		expect(response.status).toBe(422);
	});
});

// ===== 队列消费者：R2 直读 → 文本通道完整管线 =====

describe("queue consumer", () => {
	it("text channel: read from R2 -> generate -> validate -> upload", async () => {
		const calls: string[] = [];
		let uploadedBody: { questions?: unknown[] } | null = null;

		// 把测试材料写入 R2 模拟桶
		await env.R2_BUCKET.put("material.txt", "光合作用是植物利用光能将二氧化碳和水转化为有机物的过程。", {
			httpMetadata: { contentType: "text/plain" },
		});

		// Service Binding 回调（验票 / 入库）走 API_WORKER.fetch
		const apiWorker = makeApiWorker(async (url, init) => {
			if (url.includes("/api/quiz/sessions/") && url.endsWith("/status")) {
				calls.push("patch");
				return jsonResponse({ data: { status: "processing" } });
			}
			if (url.includes("/api/quiz/questions/batch")) {
				calls.push("batch");
				uploadedBody = JSON.parse(String(init?.body)) as { questions?: unknown[] };
				return jsonResponse({ data: { inserted: 2 } }, 201);
			}
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		// 模型调用走全局 fetch
		stubFetch(async (url) => {
			if (url.includes("/chat/completions")) {
				calls.push("llm");
				return jsonResponse({ choices: [{ message: { content: VALID_QUESTIONS_JSON } }] });
			}
			return new Response(`unexpected fetch: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({ API_WORKER: apiWorker, AI_PROVIDER_KEY_MAIN: "test-key" });
		const batch = {
			messages: [
				{
					body: { ticket: "t-1", materials: [{ r2Key: "material.txt", mimeType: "text/plain" }], options: { count: 5 } },
				},
			],
		} as unknown as MessageBatch<unknown>;

		await worker.queue(batch, customEnv);

		expect(calls).toEqual(["patch", "llm", "batch"]);
		expect(uploadedBody?.questions).toHaveLength(2);
	});

	it("unsupported format marks session failed without uploading", async () => {
		const calls: string[] = [];

		// 使用内存 mock R2 bucket，避免 Windows 上 SQLite 文件锁问题
		const mockR2 = {
			async get(_key: string) {
				return {
					text: async () => "fake-content",
					arrayBuffer: async () => new ArrayBuffer(0),
					httpMetadata: { contentType: "application/pdf" } as Record<string, string>,
				};
			},
		} as unknown as R2Bucket;

		const apiWorker = makeApiWorker(async (url) => {
			if (url.includes("/sessions/") && url.endsWith("/status")) {
				calls.push("patch");
				return jsonResponse({ data: { status: "processing" } });
			}
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({ API_WORKER: apiWorker, AI_PROVIDER_KEY_MAIN: "test-key", R2_BUCKET: mockR2 });
		const batch = {
			messages: [{ body: { ticket: "t-2", materials: [{ r2Key: "doc.pdf", mimeType: "application/pdf" }] } }],
		} as unknown as MessageBatch<unknown>;

		await worker.queue(batch, customEnv);

		// 首次 patch(processing) + 失败后 patch(failed)，且没有入库调用
		expect(calls).toEqual(["patch", "patch"]);
	});
});

// ===== 题目校验规则 =====

describe("validateQuestions", () => {
	it("keeps valid questions of all three types", () => {
		const parsed = parseModelJson(
			JSON.stringify({
				questions: [
					{
						type: "single_choice",
						content: { stem: "题", options: ["A", "B"] },
						answer: { correctIndex: 0 },
					},
					{ type: "true_false", content: { stem: "陈述" }, answer: { correct: true } },
					{
						type: "fill_blank",
						content: { stem: "法国首都是___" },
						answer: { correct: "巴黎", accept: ["巴黎", "Paris"] },
					},
				],
			}),
		);
		expect(validateQuestions(parsed)).toHaveLength(3);
	});

	it("drops single_choice with out-of-range correctIndex", () => {
		const parsed = parseModelJson(
			JSON.stringify({
				questions: [
					{
						type: "single_choice",
						content: { stem: "题", options: ["A", "B"] },
						answer: { correctIndex: 5 },
					},
				],
			}),
		);
		expect(validateQuestions(parsed)).toHaveLength(0);
	});

	it("drops unknown types and wrong answer shapes", () => {
		const parsed = parseModelJson(
			JSON.stringify({
				questions: [
					{ type: "essay", content: { stem: "题" }, answer: { correct: "x" } },
					{ type: "true_false", content: { stem: "陈述" }, answer: { correct: "yes" } },
				],
			}),
		);
		expect(validateQuestions(parsed)).toHaveLength(0);
	});

	it("strips code fences before parsing", () => {
		const parsed = parseModelJson('```json\n{"questions": []}\n```');
		expect(parsed).toEqual({ questions: [] });
	});
});

// ===== 提供商链故障切换 =====

describe("walkProviderChain", () => {
	const providers = parseProviders(
		JSON.stringify([
			{ name: "a", priority: 1, baseUrl: "http://a.test/v1", generateModel: "m" },
			{ name: "b", priority: 2, baseUrl: "http://b.test/v1", generateModel: "m" },
		]),
	);

	it("falls back to next provider on failure", async () => {
		const chainEnv = { AI_PROVIDER_KEY_A: "ka", AI_PROVIDER_KEY_B: "kb" };
		const { result, provider } = await walkProviderChain(chainEnv, providers, async (p) => {
			if (p.name === "a") throw new Error("500 boom");
			return "ok";
		});
		expect(result).toBe("ok");
		expect(provider.name).toBe("b");
	});

	it("throws when all providers fail", async () => {
		const chainEnv = { AI_PROVIDER_KEY_A: "ka", AI_PROVIDER_KEY_B: "kb" };
		await expect(
			walkProviderChain(chainEnv, providers, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	it("skips providers without ocrModel when filter applied", async () => {
		const withOcr = parseProviders(
			JSON.stringify([
				{ name: "a", priority: 1, baseUrl: "http://a.test/v1", generateModel: "m" },
				{ name: "b", priority: 2, baseUrl: "http://b.test/v1", generateModel: "m", ocrModel: "ocr" },
			]),
		);
		const chainEnv = { AI_PROVIDER_KEY_A: "ka", AI_PROVIDER_KEY_B: "kb" };
		const { provider } = await walkProviderChain(
			chainEnv,
			withOcr,
			async () => "ok",
			(p) => !!p.ocrModel,
		);
		expect(provider.name).toBe("b");
	});
});
