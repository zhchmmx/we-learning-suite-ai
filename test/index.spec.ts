import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuizGenerationDO } from "../src/do/quiz-generation";
import { parseModelJson, validateQuestions } from "../src/services/generate";
import { createScanSession, runScanRound } from "../src/services/pdf-scan";
import { SCAN_CHUNK_BYTES } from "../src/config";
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

/** 构造假 Ai 绑定：替换 toMarkdown；gateway 用本地桩（测试沙箱里真实远程绑定会挂起） */
function makeAi(toMarkdown: Ai["toMarkdown"]): Ai {
	return {
		toMarkdown,
		gateway: (_id: string) => ({ getUrl: async () => "https://gateway.test/v1/test-gw/" }),
	} as unknown as Ai;
}

function toMarkdownOk(data: string) {
	return vi.fn(async () => ({
		id: "conv-1",
		name: "material.pdf",
		mimeType: "application/pdf",
		format: "markdown" as const,
		tokens: 1,
		data,
	}));
}

/** 内存版 R2 bucket：支持 Range 读，记录 put / delete 便于断言 */
function makeFakeBucket() {
	const store = new Map<string, Uint8Array>();
	const puts: string[] = [];
	const deletes: string[][] = [];
	const bucket = {
		async get(key: string, options?: { range?: { offset: number; length: number } }) {
			const bytes = store.get(key);
			if (!bytes) return null;
			const offset = options?.range?.offset ?? 0;
			const length = options?.range?.length ?? bytes.length - offset;
			const slice = bytes.slice(offset, Math.min(bytes.length, offset + length));
			return {
				arrayBuffer: async () => slice.buffer,
				size: slice.length,
			};
		},
		async put(key: string, value: Uint8Array | ArrayBuffer) {
			const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
			store.set(key, bytes.slice());
			puts.push(key);
			return { size: bytes.length };
		},
		async delete(keys: string | string[]) {
			const list = Array.isArray(keys) ? keys : [keys];
			deletes.push(list);
			for (const k of list) store.delete(k);
		},
	} as unknown as R2Bucket;
	return { bucket, store, puts, deletes };
}

/** 构造假 JPEG：SOI/EOI 魔数 + 填充 */
function makeJpeg(size: number): Uint8Array {
	const bytes = new Uint8Array(Math.max(size, 4));
	bytes[0] = 0xff;
	bytes[1] = 0xd8;
	bytes[2] = 0xff;
	bytes[bytes.length - 2] = 0xff;
	bytes[bytes.length - 1] = 0xd9;
	return bytes;
}

/** 构造伪"扫描件 PDF"：对象字典 + DCTDecode 流（流内容 = 给定 JPEG 字节） */
function buildScannedPdf(jpeg: Uint8Array, padBefore = 0): Uint8Array {
	const encoder = new TextEncoder();
	const pad = new Uint8Array(padBefore); // 全零填充，不含干扰标记
	const dict = encoder.encode(
		`1 0 obj\n<< /Type /XObject /Subtype /Image /Width 1000 /Height 1400 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
	);
	const tail = encoder.encode("\nendstream\nendobj\n");
	const header = encoder.encode("%PDF-1.4\n");
	const out = new Uint8Array(header.length + pad.length + dict.length + jpeg.length + tail.length);
	let at = 0;
	out.set(header, at);
	at += header.length;
	out.set(pad, at);
	at += pad.length;
	out.set(dict, at);
	at += dict.length;
	out.set(jpeg, at);
	at += jpeg.length;
	out.set(tail, at);
	return out;
}

/** 常用：放行续期/入库/状态的 API 回调 mock，并记录调用 */
function makeOkApiWorker(calls: string[], captured?: { uploadedBody?: { questions?: unknown[] } }) {
	return makeApiWorker(async (url, init) => {
		if (url.includes("/api/quiz/sessions/") && url.endsWith("/renew")) {
			calls.push("renew");
			return jsonResponse({ data: { ok: true } });
		}
		if (url.includes("/api/quiz/sessions/") && url.endsWith("/status")) {
			calls.push("patch");
			return jsonResponse({ data: {} });
		}
		if (url.includes("/api/quiz/questions/batch")) {
			calls.push("batch");
			if (captured) captured.uploadedBody = JSON.parse(String(init?.body)) as { questions?: unknown[] };
			return jsonResponse({ data: { inserted: 2 } }, 201);
		}
		return new Response(`unexpected API call: ${url}`, { status: 599 });
	});
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

const PLAN_JSON = JSON.stringify({ totalCount: 2, types: ["single_answer", "true_false"] });

/** 语料足够长的转换结果（超过 SCAN_MIN_CHARS=100 的非空白字符） */
const RICH_MARKDOWN =
	"光合作用是植物利用光能，将二氧化碳和水转化为有机物并释放氧气的过程。" +
	"它分为光反应与暗反应两个阶段，发生在叶绿体中，是地球生态系统能量输入的主要途径。" +
	"光反应在类囊体薄膜上进行，水被分解为氧气和氢离子，同时生成 ATP 与 NADPH；" +
	"暗反应在叶绿体基质中进行，利用上述能量物质将二氧化碳固定并还原为糖类。";

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

// ===== OCR 端点（异步：委托 OCRProcessingDO，返回 taskId） =====

describe("POST /api/ocr", () => {
	const FAKE_IMAGE = { data: "aGVsbG8=", mimeType: "image/png" };

	function makeFakeOcrDO() {
		const fetchStub = vi.fn(async () => new Response(null, { status: 202 }));
		const namespace = {
			idFromName: (name: string) => ({ name }),
			get: (_id: unknown) => ({ fetch: fetchStub }),
		} as unknown as Env["OCR_DO"];
		return { namespace, fetchStub };
	}

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
		const { namespace } = makeFakeOcrDO();
		const response = await postOcr({ images: [] }, makeEnv({ OCR_DO: namespace }));
		expect(response.status).toBe(400);
	});

	it("rejects unsupported mime type with 400", async () => {
		const { namespace } = makeFakeOcrDO();
		const response = await postOcr(
			{ images: [{ data: "aGVsbG8=", mimeType: "image/gif" }] },
			makeEnv({ OCR_DO: namespace }),
		);
		expect(response.status).toBe(400);
	});

	it("dispatches to OCR DO and returns 202 with taskId", async () => {
		const { namespace, fetchStub } = makeFakeOcrDO();
		const response = await postOcr(
			{ userId: "u-1", images: [FAKE_IMAGE] },
			makeEnv({ OCR_DO: namespace }),
		);
		expect(response.status).toBe(202);
		const body = (await response.json()) as { data: { taskId: string; status: string } };
		expect(body.data.status).toBe("processing");
		expect(body.data.taskId).toBeTruthy();

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [url, init] = fetchStub.mock.calls[0];
		expect(url).toBe("http://do/ocr");
		const payload = JSON.parse(String(init?.body)) as {
			taskId: string;
			userId: string;
			images: Array<{ base64: string; mimeType: string }>;
		};
		expect(payload.taskId).toBe(body.data.taskId);
		expect(payload.userId).toBe("u-1");
		expect(payload.images).toEqual([{ base64: FAKE_IMAGE.data, mimeType: FAKE_IMAGE.mimeType }]);
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

// ===== pdf-scan：分块扫描器（内存桶单元测试） =====

describe("pdf-scan runScanRound", () => {
	it("extracts an embedded DCTDecode JPEG into temp R2 keys", async () => {
		const jpeg = makeJpeg(12 * 1024);
		const { bucket, store } = makeFakeBucket();
		store.set("scan.pdf", buildScannedPdf(jpeg));

		let session = createScanSession([{ r2Key: "scan.pdf", size: (store.get("scan.pdf") as Uint8Array).length }], 15);
		const round = await runScanRound(bucket, "u-1", "t-scan", session);
		session = round.session;

		expect(round.done).toBe(true);
		expect(round.extractedKeys).toHaveLength(1);
		expect(round.extractedKeys[0]).toBe("u-1/tmp/scan/t-scan/p1.jpg");
		const saved = store.get("u-1/tmp/scan/t-scan/p1.jpg") as Uint8Array;
		expect(saved.length).toBe(jpeg.length);
		expect(saved[0]).toBe(0xff);
		expect(saved[1]).toBe(0xd8);
	});

	it("detects a marker that straddles the 4MB chunk boundary via carry", async () => {
		const jpeg = makeJpeg(12 * 1024);
		// 让 `/DCTDecode` 标记恰好横跨第一块（4MB）边界：
		// 计算字典+流的长度，倒推填充量，使标记起点 = SCAN_CHUNK_BYTES - 5
		const probe = buildScannedPdf(jpeg, 0);
		const markerOffsetInProbe = indexOfAscii(probe, "/DCTDecode");
		const padBefore = SCAN_CHUNK_BYTES - 5 - markerOffsetInProbe;
		expect(padBefore).toBeGreaterThan(0);

		const pdf = buildScannedPdf(jpeg, padBefore);
		const { bucket, store } = makeFakeBucket();
		store.set("big-scan.pdf", pdf);

		let session = createScanSession([{ r2Key: "big-scan.pdf", size: pdf.length }], 15);

		const round1 = await runScanRound(bucket, "u-1", "t-split", session);
		session = round1.session;
		expect(round1.done).toBe(false);
		expect(round1.extractedKeys).toHaveLength(0); // 标记被边界截断，本轮看不见

		const round2 = await runScanRound(bucket, "u-1", "t-split", session);
		session = round2.session;
		expect(round2.done).toBe(true);
		expect(round2.extractedKeys).toHaveLength(1); // carry 补全后命中并抽取
	});

	it("skips images below the minimum size (logos/icons)", async () => {
		const jpeg = makeJpeg(4 * 1024); // < MIN_SCAN_IMAGE_BYTES(10KB)
		const { bucket, store } = makeFakeBucket();
		store.set("scan.pdf", buildScannedPdf(jpeg));

		const session = createScanSession([{ r2Key: "scan.pdf", size: (store.get("scan.pdf") as Uint8Array).length }], 15);
		const round = await runScanRound(bucket, "u-1", "t-small", session);

		expect(round.done).toBe(true);
		expect(round.extractedKeys).toHaveLength(0);
	});

	it("returns zero extracted for bytes without image streams", async () => {
		const { bucket, store } = makeFakeBucket();
		store.set("noimg.pdf", new TextEncoder().encode("%PDF-1.4\nno image objects here\n"));

		const session = createScanSession([{ r2Key: "noimg.pdf", size: 29 }], 15);
		const round = await runScanRound(bucket, "u-1", "t-none", session);

		expect(round.done).toBe(true);
		expect(round.extractedKeys).toHaveLength(0);
	});

	/** 字节序列中查找 ASCII 子串（测试辅助） */
	function indexOfAscii(haystack: Uint8Array, needle: string): number {
		const n = new TextEncoder().encode(needle);
		outer: for (let i = 0; i + n.length <= haystack.length; i++) {
			for (let j = 0; j < n.length; j++) {
				if (haystack[i + j] !== n[j]) continue outer;
			}
			return i;
		}
		return -1;
	}
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

		const apiWorker = makeOkApiWorker(calls, captured);

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

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			AI: makeAi(toMarkdownOk("unused") as unknown as Ai["toMarkdown"]),
		});
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
	}, 30_000);

	it("digital PDF: AI.toMarkdown converts and pipeline completes", async () => {
		const calls: string[] = [];
		const captured: { uploadedBody?: { questions?: unknown[] } } = {};
		let llmCallCount = 0;

		const fake = makeFakeBucket();
		fake.store.set("doc.pdf", new TextEncoder().encode("%PDF-1.4 fake digital pdf"));
		const toMarkdown = toMarkdownOk(RICH_MARKDOWN);

		const apiWorker = makeOkApiWorker(calls, captured);
		stubFetch(async (url) => {
			if (url.includes("/chat/completions")) {
				calls.push("llm");
				llmCallCount++;
				return sseResponse(llmCallCount === 1 ? PLAN_JSON : VALID_QUESTIONS_JSON);
			}
			return new Response(`unexpected fetch: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			R2_BUCKET: fake.bucket,
			AI: makeAi(toMarkdown as unknown as Ai["toMarkdown"]),
		});
		const { instance, mock } = await startTask(customEnv, "t-pdf-digital", [
			{ r2Key: "doc.pdf", mimeType: "application/pdf" },
		]);
		await runUntilIdle(instance, mock);

		expect(toMarkdown).toHaveBeenCalledTimes(1);
		expect(captured.uploadedBody?.questions).toHaveLength(2);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("done");
	}, 30_000);

	it("docx: AI.toMarkdown converts and pipeline completes", async () => {
		const calls: string[] = [];
		const captured: { uploadedBody?: { questions?: unknown[] } } = {};
		let llmCallCount = 0;

		const fake = makeFakeBucket();
		fake.store.set("notes.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
		const toMarkdown = toMarkdownOk(RICH_MARKDOWN);

		const apiWorker = makeOkApiWorker(calls, captured);
		stubFetch(async (url) => {
			if (url.includes("/chat/completions")) {
				llmCallCount++;
				return sseResponse(llmCallCount === 1 ? PLAN_JSON : VALID_QUESTIONS_JSON);
			}
			return new Response(`unexpected fetch: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			R2_BUCKET: fake.bucket,
			AI: makeAi(toMarkdown as unknown as Ai["toMarkdown"]),
		});
		const { instance, mock } = await startTask(customEnv, "t-docx", [
			{ r2Key: "notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
		]);
		await runUntilIdle(instance, mock);

		expect(toMarkdown).toHaveBeenCalledTimes(1);
		expect(captured.uploadedBody?.questions).toHaveLength(2);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("done");
	}, 30_000);

	it("scanned PDF: empty toMarkdown output triggers chunked scan -> OCR -> pipeline completes", async () => {
		const calls: string[] = [];
		const captured: { uploadedBody?: { questions?: unknown[] } } = {};
		let llmCallCount = 0;

		const jpeg = makeJpeg(12 * 1024);
		const fake = makeFakeBucket();
		fake.store.set("scan.pdf", buildScannedPdf(jpeg));
		// 转换结果几乎为空 → 判定扫描件
		const toMarkdown = toMarkdownOk("   ");

		const apiWorker = makeOkApiWorker(calls, captured);
		stubFetch(async (url) => {
			if (url.includes("/chat/completions")) {
				calls.push("llm");
				llmCallCount++;
				// 1: OCR 转录；2: 规划；3: 出题
				const content = llmCallCount === 1 ? "转录出的课文：光合作用是植物利用光能合成有机物的过程。"
					: llmCallCount === 2 ? PLAN_JSON : VALID_QUESTIONS_JSON;
				return sseResponse(content);
			}
			return new Response(`unexpected fetch: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			R2_BUCKET: fake.bucket,
			AI: makeAi(toMarkdown as unknown as Ai["toMarkdown"]),
		});
		const { instance, mock } = await startTask(customEnv, "t-scan-pdf", [
			{ r2Key: "scan.pdf", mimeType: "application/pdf" },
		]);
		await runUntilIdle(instance, mock);

		// toMarkdown 调过一次（判定为扫描件），页图抽出并走完 OCR → 规划 → 出题 → 入库
		expect(toMarkdown).toHaveBeenCalledTimes(1);
		expect(captured.uploadedBody?.questions).toHaveLength(2);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("done");
		// 临时页图创建后被清理
		expect(fake.puts.some((k) => k.startsWith("u-1/tmp/scan/t-scan-pdf/"))).toBe(true);
		expect(fake.deletes.flat().some((k) => k.startsWith("u-1/tmp/scan/t-scan-pdf/"))).toBe(true);
		expect(fake.store.size === 1 && fake.store.has("scan.pdf")).toBe(true);
	}, 30_000);

	it("scanned PDF: toMarkdown throwing degrades to chunked scan -> OCR -> pipeline completes", async () => {
		const calls: string[] = [];
		const captured: { uploadedBody?: { questions?: unknown[] } } = {};
		let llmCallCount = 0;

		const jpeg = makeJpeg(12 * 1024);
		const fake = makeFakeBucket();
		fake.store.set("scan-err.pdf", buildScannedPdf(jpeg));
		// 转换直接抛错（部分扫描件的真实行为）→ 应降级为分块扫描而不是失败
		const toMarkdown = vi.fn(async () => {
			throw new Error("transform backend error");
		});

		const apiWorker = makeOkApiWorker(calls, captured);
		stubFetch(async (url) => {
			if (url.includes("/chat/completions")) {
				llmCallCount++;
				const content = llmCallCount === 1 ? "转录出的课文：光合作用是植物利用光能合成有机物的过程。"
					: llmCallCount === 2 ? PLAN_JSON : VALID_QUESTIONS_JSON;
				return sseResponse(content);
			}
			return new Response(`unexpected fetch: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			R2_BUCKET: fake.bucket,
			AI: makeAi(toMarkdown as unknown as Ai["toMarkdown"]),
		});
		const { instance, mock } = await startTask(customEnv, "t-scan-err-pdf", [
			{ r2Key: "scan-err.pdf", mimeType: "application/pdf" },
		]);
		await runUntilIdle(instance, mock);

		expect(toMarkdown).toHaveBeenCalledTimes(1);
		expect(captured.uploadedBody?.questions).toHaveLength(2);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("done");
		expect(fake.puts.some((k) => k.startsWith("u-1/tmp/scan/t-scan-err-pdf/"))).toBe(true);
	}, 30_000);

	it("PDF over 32MB skips toMarkdown and goes straight to scanning", async () => {
		const bigPdf = new Uint8Array(33 * 1024 * 1024); // 全零，无图可抽
		const fake = makeFakeBucket();
		fake.store.set("huge.pdf", bigPdf);
		const toMarkdown = vi.fn();

		const patches: Array<{ status: string }> = [];
		const apiWorker = makeApiWorker(async (url, init) => {
			if (url.endsWith("/renew")) return jsonResponse({ data: { ok: true } });
			if (url.endsWith("/status")) {
				patches.push(JSON.parse(String(init?.body)) as { status: string });
				return jsonResponse({ data: {} });
			}
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			R2_BUCKET: fake.bucket,
			AI: makeAi(toMarkdown as unknown as Ai["toMarkdown"]),
		});
		const { instance, mock } = await startTask(customEnv, "t-huge-pdf", [
			{ r2Key: "huge.pdf", mimeType: "application/pdf" },
		]);
		await runUntilIdle(instance, mock);

		// 超大 PDF 不调 toMarkdown（内存护栏），直入扫描；无图可抽 → 失败
		expect(toMarkdown).not.toHaveBeenCalled();
		expect(patches).toEqual([{ status: "failed" }]);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("failed");
	});

	it("scanned PDF without extractable images fails with a clear error", async () => {
		const fake = makeFakeBucket();
		fake.store.set("empty-scan.pdf", new TextEncoder().encode("%PDF-1.4\nno image objects\n"));
		const toMarkdown = toMarkdownOk(""); // 空输出 → 扫描件

		const patches: Array<{ status: string }> = [];
		const apiWorker = makeApiWorker(async (url, init) => {
			if (url.endsWith("/renew")) return jsonResponse({ data: { ok: true } });
			if (url.endsWith("/status")) {
				patches.push(JSON.parse(String(init?.body)) as { status: string });
				return jsonResponse({ data: {} });
			}
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			R2_BUCKET: fake.bucket,
			AI: makeAi(toMarkdown as unknown as Ai["toMarkdown"]),
		});
		const { instance, mock } = await startTask(customEnv, "t-empty-scan", [
			{ r2Key: "empty-scan.pdf", mimeType: "application/pdf" },
		]);
		await runUntilIdle(instance, mock);

		expect(patches).toEqual([{ status: "failed" }]);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("failed");
	});

	it("encrypted/corrupted document: toMarkdown failure marks session failed", async () => {
		const fake = makeFakeBucket();
		fake.store.set("locked.docx", new Uint8Array([0x50, 0x4b]));
		const toMarkdown = vi.fn(async () => {
			throw new Error("conversion backend error");
		});

		const patches: Array<{ status: string }> = [];
		const apiWorker = makeApiWorker(async (url, init) => {
			if (url.endsWith("/renew")) return jsonResponse({ data: { ok: true } });
			if (url.endsWith("/status")) {
				patches.push(JSON.parse(String(init?.body)) as { status: string });
				return jsonResponse({ data: {} });
			}
			return new Response(`unexpected API call: ${url}`, { status: 599 });
		});

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			R2_BUCKET: fake.bucket,
			AI: makeAi(toMarkdown as unknown as Ai["toMarkdown"]),
		});
		const { instance, mock } = await startTask(customEnv, "t-locked", [
			{ r2Key: "locked.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
		]);
		await runUntilIdle(instance, mock);

		expect(patches).toEqual([{ status: "failed" }]);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("failed");
	});

	it("cancellation: renew rejected with 4xx aborts the task without uploading", async () => {
		const calls: string[] = [];

		await env.R2_BUCKET.put("material-cancel.txt", "光合作用相关材料内容", {
			httpMetadata: { contentType: "text/plain" },
		});

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

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			AI: makeAi(toMarkdownOk("unused") as unknown as Ai["toMarkdown"]),
		});
		const { instance, mock } = await startTask(customEnv, "t-do-3", [
			{ r2Key: "material-cancel.txt", mimeType: "text/plain" },
		]);
		await runUntilIdle(instance, mock);

		// planning(llm) → 续期被 403 拒绝（取消信号）→ 中止 → 标记 failed，不再生成也不再上传
		expect(calls).toEqual(["llm", "renew-rejected", "patch-failed"]);
		expect((mock.data.get("task") as { phase: string }).phase).toBe("failed");
	}, 30_000);

	it("duplicate delivery for the same ticket is rejected (idempotency guard)", async () => {
		let llmCalls = 0;

		await env.R2_BUCKET.put("material-dup.txt", "重复投递测试材料", {
			httpMetadata: { contentType: "text/plain" },
		});

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

		const customEnv = makeEnv({
			API_WORKER: apiWorker,
			CF_AIG_TOKEN: "test-token",
			AI: makeAi(toMarkdownOk("unused") as unknown as Ai["toMarkdown"]),
		});
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
	}, 30_000);
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
						content: { stem: "题", options: ["A", "B", "C", "D"] },
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
