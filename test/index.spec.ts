import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProviders } from "../src/config";
import { QuizGenerationDO } from "../src/do/quiz-generation";
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

/** 构造 SSE 流式响应（模拟 OpenAI streaming chat completion） */
function sseResponse(content: string): Response {
	const delta = JSON.stringify({ choices: [{ delta: { content } }] });
	const body = `data: ${delta}\n\ndata: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

/** 构造带自定义绑定的测试 env（替换 Service Binding 与队列绑定，注入提供商密钥） */
function makeEnv(overrides: Record<string, unknown>): Env {
	return { ...env, ...overrides } as unknown as Env;
}

const VALID_QUESTIONS_JSON = JSON.stringify({
	questions: [
		{
			type: "single_answer",
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
			{ userId: "u-1", materials: [{ r2Key: "a.txt", mimeType: "text/plain" }] },
			makeEnv({ API_WORKER: rejectAllApiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects missing userId with 400", async () => {
		const send = vi.fn();
		const response = await postGenerate(
			{ ticket: "t-1", materials: [{ r2Key: "a.txt", mimeType: "text/plain" }] },
			makeEnv({ API_WORKER: rejectAllApiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(400);
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects invalid materials with 400", async () => {
		const send = vi.fn();
		const response = await postGenerate(
			{ ticket: "t-1", userId: "u-1", materials: [] },
			makeEnv({ API_WORKER: rejectAllApiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(400);
		expect(send).not.toHaveBeenCalled();
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
			{ ticket: "t-1", userId: "u-1", materials: [{ r2Key: "a.txt", mimeType: "text/plain" }] },
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
			{ ticket: "t-1", userId: "u-1", materials: [{ r2Key: "a.txt", mimeType: "text/plain" }] },
			makeEnv({ API_WORKER: apiWorker, QUIZ_QUEUE: { send } }),
		);
		expect(response.status).toBe(202);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({
			ticket: "t-1",
			userId: "u-1",
			materials: [{ r2Key: "a.txt", mimeType: "text/plain" }],
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
				return sseResponse("转录出来的文字");
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
				return sseResponse("   ");
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

// ===== 队列消费者：把任务转投 Durable Object 后立即 ack =====

describe("queue consumer", () => {
	/** 假 DO 命名空间：捕获消费者对 stub.fetch 的调用，不真正启动 pool 的 DO 模拟 */
	function makeFakeQuizDO(status: number) {
		const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status }));
		const namespace = {
			idFromName: (name: string) => ({ name }),
			get: (_id: unknown) => ({ fetch: fetchStub }),
		} as unknown as Env["QUIZ_DO"];
		return { namespace, fetchStub };
	}

	function makeBatch(ticket: string): MessageBatch<unknown> {
		return {
			messages: [{ body: { ticket, userId: "u-1", materials: [{ r2Key: "a.txt", mimeType: "text/plain" }] } }],
		} as unknown as MessageBatch<unknown>;
	}

	it("forwards queue messages to the Durable Object and acks", async () => {
		const { namespace, fetchStub } = makeFakeQuizDO(202);
		await worker.queue(makeBatch("t-q-1"), makeEnv({ QUIZ_DO: namespace }));

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [url, init] = fetchStub.mock.calls[0];
		expect(url).toBe("http://do/start");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({
			ticket: "t-q-1",
			userId: "u-1",
			materials: [{ r2Key: "a.txt", mimeType: "text/plain" }],
		});
	});

	it("acks the message without retrying when the DO rejects a duplicate (409)", async () => {
		const { namespace, fetchStub } = makeFakeQuizDO(409);
		await expect(worker.queue(makeBatch("t-q-2"), makeEnv({ QUIZ_DO: namespace }))).resolves.toBeUndefined();
		expect(fetchStub).toHaveBeenCalledTimes(1);
	});
});

// ===== QuizGenerationDO：alarm 状态机驱动完整管线 =====
//
// 直接实例化 DO 并用内存版 storage 驱动 alarm，不走 pool 的 DO 模拟：
// vitest-pool-workers 在 Windows 上对 Durable Object SQLite 存储有兼容缺陷
// （isolated storage pop 时 EBUSY / 关闭隔离后 SQLITE_CANTOPEN）。

describe("QuizGenerationDO alarm state machine", () => {
	type MockDOStateData = {
		data: Map<string, unknown>;
		pendingAlarm: number | null;
	};

	/** 内存版 DurableObjectState：get/put/delete/setAlarm 全部落到 Map 上 */
	function makeMockDOState(): { state: DurableObjectState; mock: MockDOStateData } {
		const mock: MockDOStateData = { data: new Map(), pendingAlarm: null };
		const storage = {
			get: async (key: string) => mock.data.get(key),
			put: async (key: string, value: unknown) => {
				mock.data.set(key, value);
			},
			delete: async (key: string) => {
				mock.data.delete(key);
			},
			setAlarm: async (time: number) => {
				mock.pendingAlarm = time;
			},
			getAlarm: async () => mock.pendingAlarm,
		};
		return { state: { storage } as unknown as DurableObjectState, mock };
	}

	/** 逐轮执行 alarm 处理器，直到没有已调度的 alarm 为止 */
	async function runUntilIdle(instance: QuizGenerationDO, mock: MockDOStateData): Promise<void> {
		let guard = 0;
		while (mock.pendingAlarm !== null && guard++ < 20) {
			mock.pendingAlarm = null;
			await instance.alarm();
		}
		expect(mock.pendingAlarm).toBeNull();
	}

	/** 创建 DO 实例并投递任务（等价于队列消费者调用 stub.fetch） */
	async function startTask(
		customEnv: Env,
		ticket: string,
		materials: Array<{ r2Key: string; mimeType: string }>,
	): Promise<{ instance: QuizGenerationDO; mock: MockDOStateData }> {
		const { state, mock } = makeMockDOState();
		const instance = new QuizGenerationDO(state, customEnv);
		const res = await instance.fetch(
			new Request("http://do/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ticket, userId: "u-1", materials }),
			}),
		);
		expect(res.status).toBe(202);
		return { instance, mock };
	}

	it("text channel: plan -> generate -> validate -> upload, phase ends done", async () => {
		const calls: string[] = [];
		// 用对象属性捕获上传内容：局部 let 在闭包中赋值会被 TS 控制流收窄为 null
		const captured: { uploadedBody?: { questions?: unknown[] } } = {};
		let llmCallCount = 0;

		// 把测试材料写入 R2 模拟桶
		await env.R2_BUCKET.put("material.txt", "光合作用是植物利用光能将二氧化碳和水转化为有机物的过程。", {
			httpMetadata: { contentType: "text/plain" },
		});

		// 规划阶段输出：2 道题，1 个批次即可生成完
		const PLAN_JSON = JSON.stringify({ totalCount: 2, types: ["single_answer", "true_false"] });

		// Service Binding 回调（续期 / 入库）走 API_WORKER.fetch
		const apiWorker = makeApiWorker(async (url, init) => {
			if (url.includes("/api/quiz/sessions/") && url.endsWith("/renew")) {
				calls.push("renew");
				return jsonResponse({ data: { ok: true } });
			}
			if (url.includes("/api/quiz/sessions/") && url.endsWith("/status")) {
				calls.push("patch");
				return jsonResponse({ data: { status: "failed" } });
			}
			if (url.includes("/api/quiz/questions/batch")) {
				calls.push("batch");
				captured.uploadedBody = JSON.parse(String(init?.body)) as { questions?: unknown[] };
				return jsonResponse({ data: { inserted: 2 } }, 201);
			}
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		// 模型调用走全局 fetch：第 1 次返回规划，第 2 次返回题目（流式 SSE）
		stubFetch(async (url) => {
			if (url.includes("/chat/completions")) {
				calls.push("llm");
				llmCallCount++;
				const content = llmCallCount === 1 ? PLAN_JSON : VALID_QUESTIONS_JSON;
				return sseResponse(content);
			}
			return new Response(`unexpected fetch: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({ API_WORKER: apiWorker, AI_PROVIDER_KEY_MAIN: "test-key" });
		const { instance, mock } = await startTask(customEnv, "t-do-1", [
			{ r2Key: "material.txt", mimeType: "text/plain" },
		]);
		await runUntilIdle(instance, mock);

		// planning(llm) → 续期 → 续期 → generating(llm) → uploading(batch)
		expect(calls).toEqual(["llm", "renew", "renew", "llm", "batch"]);
		expect(captured.uploadedBody?.questions).toHaveLength(2);
		// 终态检查：任务完成、语料已释放
		expect((mock.data.get("task") as { phase: string }).phase).toBe("done");
		expect(mock.data.has("corpus")).toBe(false);
	});

	it("unsupported format marks session failed without uploading", async () => {
		const patches: Array<{ status: string }> = [];

		// 使用内存 mock R2 bucket，返回不支持的 PDF 格式
		const mockR2 = {
			async get(_key: string) {
				return {
					text: async () => "fake-content",
					arrayBuffer: async () => new ArrayBuffer(0),
					httpMetadata: { contentType: "application/pdf" } as Record<string, string>,
				};
			},
		} as unknown as R2Bucket;

		const apiWorker = makeApiWorker(async (url, init) => {
			if (url.includes("/sessions/") && url.endsWith("/status")) {
				patches.push(JSON.parse(String(init?.body)) as { status: string });
				return jsonResponse({ data: {} });
			}
			if (url.includes("/sessions/") && url.endsWith("/renew")) {
				return jsonResponse({ data: { ok: true } });
			}
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({ API_WORKER: apiWorker, AI_PROVIDER_KEY_MAIN: "test-key", R2_BUCKET: mockR2 });
		const { instance, mock } = await startTask(customEnv, "t-do-2", [
			{ r2Key: "doc.pdf", mimeType: "application/pdf" },
		]);
		await runUntilIdle(instance, mock);

		// 仅一次回调：规划阶段失败后标记 failed，没有入库
		expect(patches).toEqual([{ status: "failed" }]);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("failed");
	});

	it("cancellation: renew rejected with 4xx aborts the task without uploading", async () => {
		const calls: string[] = [];

		await env.R2_BUCKET.put("material-cancel.txt", "光合作用相关材料内容", {
			httpMetadata: { contentType: "text/plain" },
		});
		const PLAN_JSON = JSON.stringify({ totalCount: 2, types: ["single_answer"] });

		const apiWorker = makeApiWorker(async (url, init) => {
			if (url.endsWith("/renew")) {
				calls.push("renew-rejected");
				return jsonResponse({ error: "Session cancelled" }, 403);
			}
			if (url.endsWith("/status")) {
				const body = JSON.parse(String(init?.body)) as { status: string };
				calls.push(`patch-${body.status}`);
				return jsonResponse({ data: {} });
			}
			if (url.includes("/questions/batch")) {
				calls.push("batch");
				return jsonResponse({ data: { inserted: 0 } }, 201);
			}
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		stubFetch(async (url) => {
			if (url.includes("/chat/completions")) {
				calls.push("llm");
				return sseResponse(PLAN_JSON);
			}
			return new Response(`unexpected fetch: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({ API_WORKER: apiWorker, AI_PROVIDER_KEY_MAIN: "test-key" });
		const { instance, mock } = await startTask(customEnv, "t-do-3", [
			{ r2Key: "material-cancel.txt", mimeType: "text/plain" },
		]);
		await runUntilIdle(instance, mock);

		// planning(llm) → 续期被 403 拒绝（取消信号）→ 中止 → 标记 failed，不再生成也不再上传
		expect(calls).toEqual(["llm", "renew-rejected", "patch-failed"]);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("failed");
	});

	it("duplicate delivery for the same ticket is rejected (idempotency guard)", async () => {
		let llmCalls = 0;

		await env.R2_BUCKET.put("material-dup.txt", "重复投递测试材料", {
			httpMetadata: { contentType: "text/plain" },
		});
		const PLAN_JSON = JSON.stringify({ totalCount: 1, types: ["true_false"] });

		const apiWorker = makeApiWorker(async (url) => {
			if (url.endsWith("/renew")) return jsonResponse({ data: { ok: true } });
			if (url.endsWith("/status")) return jsonResponse({ data: {} });
			if (url.includes("/questions/batch")) return jsonResponse({ data: { inserted: 1 } }, 201);
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		stubFetch(async (url) => {
			if (url.includes("/chat/completions")) {
				llmCalls++;
				return sseResponse(llmCalls === 1 ? PLAN_JSON : VALID_QUESTIONS_JSON);
			}
			return new Response(`unexpected fetch: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({ API_WORKER: apiWorker, AI_PROVIDER_KEY_MAIN: "test-key" });
		const materials = [{ r2Key: "material-dup.txt", mimeType: "text/plain" }];
		const { instance, mock } = await startTask(customEnv, "t-do-4", materials);
		await runUntilIdle(instance, mock);
		const llmCallsAfterFirstRun = llmCalls;
		expect(llmCallsAfterFirstRun).toBeGreaterThanOrEqual(2);

		// 第二次投递同一 ticket：任务已完成，DO 返回 409，不产生任何新调用
		const dupRes = await instance.fetch(
			new Request("http://do/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ticket: "t-do-4", materials }),
			}),
		);
		expect(dupRes.status).toBe(409);
		await runUntilIdle(instance, mock);
		expect(llmCalls).toBe(llmCallsAfterFirstRun);
	});
});

// ===== 题目校验规则 =====

describe("validateQuestions", () => {
	it("keeps valid questions of all five types", () => {
		const parsed = parseModelJson(
			JSON.stringify({
				questions: [
					{
						type: "single_answer",
						content: { stem: "题", options: ["A", "B"] },
						answer: { correctIndex: 0 },
					},
					{
						type: "multiple_answer",
						content: { stem: "多选题", options: ["A", "B", "C", "D"] },
						answer: { correctIndices: [0, 2] },
					},
					{ type: "true_false", content: { stem: "陈述" }, answer: { correct: true } },
					{
						type: "fill_blank",
						content: { stem: "___是法国首都，___是日本首都" },
						answer: { correct: ["巴黎", "东京"], accept: [["巴黎", "Paris"], ["东京", "Tokyo"]] },
					},
					{
						type: "short_answer",
						content: { stem: "简述光合作用的过程" },
						answer: { correct: "植物利用光能将CO2和H2O转化为有机物和O2", accept: ["光合作用", "光反应", "暗反应"] },
					},
				],
			}),
		);
		expect(validateQuestions(parsed)).toHaveLength(5);
	});

	it("drops single_answer with out-of-range correctIndex", () => {
		const parsed = parseModelJson(
			JSON.stringify({
				questions: [
					{
						type: "single_answer",
						content: { stem: "题", options: ["A", "B"] },
						answer: { correctIndex: 5 },
					},
				],
			}),
		);
		expect(validateQuestions(parsed)).toHaveLength(0);
	});

	it("drops multiple_answer with fewer than 2 correct indices", () => {
		const parsed = parseModelJson(
			JSON.stringify({
				questions: [
					{
						type: "multiple_answer",
						content: { stem: "题", options: ["A", "B", "C"] },
						answer: { correctIndices: [0] },
					},
				],
			}),
		);
		expect(validateQuestions(parsed)).toHaveLength(0);
	});

	it("drops multiple_answer with out-of-range or duplicate indices", () => {
		const outOfRange = parseModelJson(
			JSON.stringify({
				questions: [{
					type: "multiple_answer",
					content: { stem: "题", options: ["A", "B", "C"] },
					answer: { correctIndices: [0, 5] },
				}],
			}),
		);
		expect(validateQuestions(outOfRange)).toHaveLength(0);

		const duplicate = parseModelJson(
			JSON.stringify({
				questions: [{
					type: "multiple_answer",
					content: { stem: "题", options: ["A", "B", "C"] },
					answer: { correctIndices: [0, 0] },
				}],
			}),
		);
		expect(validateQuestions(duplicate)).toHaveLength(0);
	});

	it("drops short_answer with empty correct text", () => {
		const parsed = parseModelJson(
			JSON.stringify({
				questions: [
					{
						type: "short_answer",
						content: { stem: "什么是光合作用?" },
						answer: { correct: "   " },
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
	}, 15_000);

	it("throws when all providers fail", async () => {
		const chainEnv = { AI_PROVIDER_KEY_A: "ka", AI_PROVIDER_KEY_B: "kb" };
		await expect(
			walkProviderChain(chainEnv, providers, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	}, 15_000);

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
