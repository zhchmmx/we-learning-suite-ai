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

	it("route mode maps dynamic routes to provider/model targets", () => {
		expect(planModels({ ...env, USE_DIRECT_MODELS: "false" })).toEqual([{ provider: "dynamic", model: "plan_auto" }]);
		expect(generateModels({ ...env, USE_DIRECT_MODELS: "false" })).toEqual([{ provider: "dynamic", model: "generate_auto" }]);
		expect(ocrModels({ ...env, USE_DIRECT_MODELS: "false" })).toEqual([{ provider: "dynamic", model: "ocr_auto" }]);
	});
});
