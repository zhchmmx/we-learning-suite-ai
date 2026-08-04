import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// wrangler.jsonc 声明了 Service Binding API_WORKER → we-learning-suite-api，
					// 但测试环境里没有另一个 Worker 在跑。这里注册一个同名 mock Worker，
					// 让 miniflare 能启动。测试用例通过 makeEnv({ API_WORKER: ... }) 覆盖这个 mock，
					// 走自己的断言逻辑。
					workers: [
						{
							name: "we-learning-suite-api",
							modules: [
								{
									type: "ESModule",
									path: "mock-api.mjs",
									contents: `export default { fetch: () => new Response("mock", { status: 599 }) };`,
								},
							],
							compatibilityDate: "2026-08-03",
						},
					],
				},
			},
		},
	},
});
