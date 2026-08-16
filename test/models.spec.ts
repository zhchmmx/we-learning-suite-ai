import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GENERATE_MODEL_CHAIN, OCR_MODEL_CHAIN, PLAN_MODEL_CHAIN } from "../src/config";
import { generateModels, ocrModels, planModels } from "../src/services/models";

// 复用 wrangler.jsonc + .dev.vars 的真实变量，验证模型解析与开关行为
describe("model chain resolution", () => {
	it("direct mode resolves plan/generate/ocr chains from config", () => {
		expect(env.USE_DIRECT_MODELS).toBe("true");
		expect(planModels(env)).toEqual([...PLAN_MODEL_CHAIN]);
		expect(generateModels(env)).toEqual([...GENERATE_MODEL_CHAIN]);
		expect(ocrModels(env)).toEqual([...OCR_MODEL_CHAIN]);
	});

	it("route mode falls back to dynamic route names", () => {
		expect(planModels({ ...env, USE_DIRECT_MODELS: "false" })).toEqual([{ route: env.AI_PLAN_MODEL }]);
		expect(generateModels({ ...env, USE_DIRECT_MODELS: "false" })).toEqual([{ route: env.AI_GENERATE_MODEL }]);
		expect(ocrModels({ ...env, USE_DIRECT_MODELS: "false" })).toEqual([{ route: env.AI_OCR_MODEL }]);
	});
});
