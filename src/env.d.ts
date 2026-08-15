/**
 * 补充 wrangler types 未自动生成的 secret 类型。
 * CF_AIG_TOKEN 通过 wrangler versions secret put 设置，
 * wrangler types 不会拾取版本化 secret，需手动声明。
 */
interface Env {
	CF_AIG_TOKEN: string;
}
