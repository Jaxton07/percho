/**
 * 内置 webfetch 工具 barrel：实现拆在本目录三模块，入口 = tools/webfetch/index.ts（原 webfetch.ts）。
 * - ip-guard.ts      SSRF 防护（IP/CIDR 判定 + assertPublicUrl，安全关键独立成文件便于审计）
 * - html-to-text.ts  HTML → 可读文本（主区域选择 + 噪音剥离）
 * - tool.ts          工具定义（参数 schema + 抓取循环 + 截断）
 */
export { htmlToText } from "./html-to-text";
export {
	assertPublicUrl,
	type Cidr,
	FAKE_IP_CIDR,
	ipInCidr,
	isPublicIp,
	parseCidr,
} from "./ip-guard";
export { makeWebFetchTool, type WebFetchDetails, type WebFetchOptions } from "./tool";
