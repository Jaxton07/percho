import dns from "node:dns";
import { isIP } from "node:net";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_CHARS = 30_000;

const webFetchParams = Type.Object({
	url: Type.String({ description: "The http:// or https:// URL to fetch" }),
	maxChars: Type.Optional(
		Type.Integer({
			minimum: 1000,
			maximum: 200_000,
			default: DEFAULT_MAX_CHARS,
			description: "Maximum characters to return (default 30000)",
		}),
	),
});

/** webfetch 工具的结构化详情（tool_execution_end 的 result.details） */
export interface WebFetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	/** 实际抓取的字节数（上限 2MB） */
	fetchedBytes: number;
	/** 返回文本的字节数（截断后） */
	bytes: number;
	truncated: boolean;
}

/** 已解析的 IPv4 CIDR（base 为 32 位大整数） */
export interface Cidr {
	base: bigint;
	bits: number;
}

function v4ToInt(ip: string): bigint {
	return ip.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

/** 从 v4-mapped/v4-translated IPv6（::ffff: 前缀）提取低 32 位对应的 IPv4；非该形式返回 undefined。
 *  同时支持点分（::ffff:198.18.0.45）与十六进制（::ffff:0:c612:2d）两种系统解析器输出。 */
function v4FromMappedV6(ip6: string): string | undefined {
	const lower = ip6.toLowerCase();
	if (!lower.startsWith("::ffff:")) return undefined;
	const rest = lower.slice(7);
	if (rest.includes(".")) return rest;
	const groups = rest
		.split(":")
		.slice(-2)
		.map((group) => group.padStart(4, "0"));
	const hex = groups.join("");
	if (hex.length !== 8) return undefined;
	return [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(".");
}

/** 把（可能压缩的）IPv6 展开成 8 个四位十六进制组；尾部点分 v4（64:ff9b::127.0.0.1）一并转换。无法展开返回 undefined */
function expandV6(ip6: string): string[] | undefined {
	let s = ip6.toLowerCase();
	if (s.includes(".")) {
		const idx = s.lastIndexOf(":");
		const v4 = s.slice(idx + 1);
		if (isIP(v4) !== 4) return undefined;
		const parts = v4.split(".").map(Number);
		const hi = (((parts[0] ?? 0) << 8) | (parts[1] ?? 0)).toString(16);
		const lo = (((parts[2] ?? 0) << 8) | (parts[3] ?? 0)).toString(16);
		s = `${s.slice(0, idx)}:${hi}:${lo}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
	const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
	return groups.map((g) => g.padStart(4, "0"));
}

/** 取展开后 IPv6 最后两组对应的点分 IPv4 */
function v4FromLastGroups(g6: string, g7: string): string {
	const hex = `${g6}${g7}`;
	return [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(".");
}

/**
 * 判断 IP 是否为私网/保留地址（SSRF 拦截用）。
 * 覆盖 IPv4 私网段、回环、链路本地、CGNAT、组播/保留段；
 * IPv6 回环/ULA/链路本地/站点本地/组播，以及内嵌 v4 的 v4-mapped、v4-compatible（::/96）、NAT64（64:ff9b::/96）。
 */
export function isPublicIp(ip: string): boolean {
	if (isIP(ip) === 4) {
		const parts = ip.split(".").map(Number);
		const a = parts[0] ?? 0;
		const b = parts[1] ?? 0;
		if (a === 0 || a === 10) return false;
		if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
		if (a === 127) return false;
		if (a === 169 && b === 254) return false; // 链路本地
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && (b === 0 || b === 168)) return false;
		if (a >= 224) return false; // 组播 + 保留
		return true;
	}
	if (isIP(ip) === 6) {
		const groups = expandV6(ip);
		if (!groups) return false;
		const first = Number.parseInt(groups[0] ?? "0", 16);
		if (first >= 0xff00) return false; // ff00::/8 组播
		if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 链路本地
		if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
		if ((first & 0xffc0) === 0xfec0) return false; // fec0::/10 废弃站点本地
		const firstFiveZero = groups.slice(0, 5).every((g) => g === "0000");
		if (firstFiveZero && (groups[5] === "0000" || groups[5] === "ffff")) {
			// ::/96 v4-compatible（含 ::、::1，内嵌 0.x/127.x 由 v4 规则拦）与 ::ffff:/96 v4-mapped
			return isPublicIp(v4FromLastGroups(groups[6] ?? "0", groups[7] ?? "0"));
		}
		if (groups[0] === "0064" && groups[1] === "ff9b") {
			// NAT64 64:ff9b::/96 内嵌 IPv4（64:ff9b::7f00:1 = 127.0.0.1）
			return isPublicIp(v4FromLastGroups(groups[6] ?? "0", groups[7] ?? "0"));
		}
		return true;
	}
	return false;
}

/** 解析 "a.b.c.d/n" 形式的 IPv4 CIDR */
export function parseCidr(cidr: string): Cidr {
	const [base, bitsPart] = cidr.split("/");
	const bits = Number(bitsPart);
	if (!bitsPart || !Number.isInteger(bits) || bits < 0 || bits > 32 || isIP(base ?? "") !== 4) {
		throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
	}
	return { base: v4ToInt(base ?? ""), bits };
}

/** IP 是否落在 CIDR 内；仅支持 IPv4（含 v4-mapped IPv6），其余返回 false */
export function ipInCidr(ip: string, cidr: Cidr): boolean {
	let v4: string | undefined;
	if (isIP(ip) === 4) {
		v4 = ip;
	} else if (isIP(ip) === 6) {
		v4 = v4FromMappedV6(ip);
	}
	if (!v4 || isIP(v4) !== 4) return false;
	const mask = cidr.bits === 0 ? 0n : (~0n << BigInt(32 - cidr.bits)) & 0xffffffffn;
	return (v4ToInt(v4) & mask) === (cidr.base & mask);
}

/** 198.18.0.0/15：RFC 2544 基准测试段，clash/surge/sing-box 类 fake-ip DNS 代理的默认段。
 *  该段不可路由、无真实服务，拦它只会在代理环境下让 webfetch 全挂，故默认放行。 */
export const FAKE_IP_CIDR: Cidr = { base: 0xc6120000n, bits: 15 };

/** 校验 URL 只允许公开 http(s) 目标；host 解析后任一地址非公网且不在 allowRanges 即拦截。
 *  注意：这是 best-effort 预检 —— fetch 内部会自行再做一次 DNS 解析，与本次校验存在 TOCTOU 窗口
 * （DNS rebinding 可让两次解析结果不同）。完备防护需在连接层钉住已验证 IP；
 * 目前与 pi-web-access 等同类实现水位一致。 */
export async function assertPublicUrl(rawUrl: string, allowRanges: Cidr[] = []): Promise<URL> {
	const isAllowed = (addr: string) => isPublicIp(addr) || allowRanges.some((cidr) => ipInCidr(addr, cidr));
	const url = new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`webfetch only supports http:// and https:// URLs (got ${url.protocol})`);
	}
	if (url.username || url.password) {
		throw new Error("URL must not contain credentials");
	}
	const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
	if (isIP(host)) {
		if (!isAllowed(host)) throw new Error(`Blocked URL: private address ${host}`);
		return url;
	}
	let addresses: string[];
	try {
		addresses = (await dns.promises.lookup(host, { all: true })).map((entry) => entry.address);
	} catch {
		throw new Error(`Could not resolve host: ${url.hostname}`);
	}
	if (addresses.length === 0 || addresses.some((addr) => !isAllowed(addr))) {
		throw new Error(`Blocked URL: ${url.hostname} resolves to a non-public address`);
	}
	return url;
}

/** 主内容区域选择：取最长的 <main>/<article>（原始 HTML 至少 200 字符才采信，防空 main 的 SPA 壳误选），否则全文。
 *  非贪婪正则对嵌套同名标签会提前截断，取最长匹配兜底，作为启发式足够。 */
function pickMainRegion(html: string): string {
	let best = "";
	for (const re of [/<main\b[^>]*>[\s\S]*?<\/main>/gi, /<article\b[^>]*>[\s\S]*?<\/article>/gi]) {
		for (const m of html.matchAll(re)) {
			if (m[0].length > best.length) best = m[0];
		}
	}
	return best.length >= 200 ? best : html;
}

/** 简单 HTML → 可读文本：剥 script/style 与 nav/aside/footer/form 等页面框架噪音、
 *  优先 main/article 主区域、保留链接为 [text](href)、代码块包 ```、块级标签换行 */
export function htmlToText(html: string): string {
	let s = pickMainRegion(html)
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|template|svg|head)[\s\S]*?<\/\1>/gi, "")
		.replace(/<(nav|aside|footer|form)[\s\S]*?<\/\1>/gi, "")
		.replace(/<a[^>]*>\s*skip to (?:content|main)[^<]*<\/a>/gi, "")
		.replace(/<pre[\s\S]*?<\/pre>/gi, (block) => {
			const code = block.replace(/<[^>]*>/g, "").trim();
			return code ? `\n\`\`\`\n${code}\n\`\`\`\n` : "";
		})
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code: string) => `\`${code.replace(/<[^>]*>/g, "")}\``)
		.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
			const label = text.replace(/<[^>]*>/g, "").trim();
			return label ? `[${label}](${href})` : "";
		})
		.replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `\n${"#".repeat(Number(level))} `)
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(
			/<br\s*\/?>|<hr\s*\/?>|<\/(p|div|li|ul|ol|h[1-6]|table|blockquote|section|article|header|footer|form|dl|dt|dd|details|summary)>/gi,
			"\n",
		)
		.replace(/<[^>]*>/g, "")
		.replace(
			/&lt;|&gt;|&quot;|&apos;|&#(\d+);|&#x([0-9a-f]+);|&amp;|&nbsp;/gi,
			(match, dec: string, hex: string) => {
				switch (match) {
					case "&lt;":
						return "<";
					case "&gt;":
						return ">";
					case "&quot;":
						return '"';
					case "&apos;":
						return "'";
					case "&amp;":
						return "&";
					case "&nbsp;":
						return " ";
					default:
						if (dec) return String.fromCodePoint(Number(dec));
						if (hex) return String.fromCodePoint(parseInt(hex, 16));
						return match;
				}
			},
		);
	s = s
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{2,}/g, "\n")
		.replace(/ {2,}/g, " ")
		.trim();
	return s;
}

interface FetchResult {
	text: string;
	finalUrl: string;
	status: number;
	contentType: string;
	/** 实际抓取的字节数（上限 MAX_BYTES） */
	bytes: number;
}

/** 只跟随真正的重定向状态码；300/304/305 等没有重定向语义，落到非 2xx 报错 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 带 SSRF 校验的 GET：手动跟随重定向（每跳重新校验），响应体上限 MAX_BYTES，超时 TIMEOUT_MS */
async function fetchPublic(
	startUrl: URL,
	signal: AbortSignal | undefined,
	allowRanges: Cidr[],
): Promise<FetchResult> {
	const combined = signal
		? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
		: AbortSignal.timeout(TIMEOUT_MS);
	let url = startUrl;
	let response: Response;
	for (let hop = 0; ; hop++) {
		response = await fetch(url, { redirect: "manual", signal: combined });
		const status = response.status;
		if (REDIRECT_STATUSES.has(status)) {
			const location = response.headers.get("location");
			if (!location) {
				throw new Error(`webfetch: redirect without Location from ${url.href} (status ${status})`);
			}
			if (hop >= MAX_REDIRECTS) {
				throw new Error(`webfetch: too many redirects (max ${MAX_REDIRECTS})`);
			}
			await response.body?.cancel().catch(() => {});
			url = await assertPublicUrl(new URL(location, url).href, allowRanges);
			continue;
		}
		break;
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`webfetch: HTTP ${response.status} ${response.statusText} for ${url.href}`);
	}
	const contentType = response.headers.get("content-type") ?? "";
	const charsetMatch = /charset=([\w-]+)/i.exec(contentType);
	let charset: string | undefined;
	if (charsetMatch) {
		try {
			new TextDecoder(charsetMatch[1]);
			charset = charsetMatch[1];
		} catch {
			// 未知编码回退 utf-8
		}
	}
	const decoder = new TextDecoder(charset);
	const reader = response.body?.getReader();
	const bytes: Uint8Array[] = [];
	let total = 0;
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.length > MAX_BYTES) {
				bytes.push(value.subarray(0, MAX_BYTES - total));
				total = MAX_BYTES;
				await reader.cancel().catch(() => {});
				break;
			}
			bytes.push(value);
			total += value.length;
		}
	}
	return {
		text: decoder.decode(Buffer.concat(bytes)),
		finalUrl: url.href,
		status: response.status,
		contentType,
		bytes: total,
	};
}

/**
 * 内置 webfetch 工具：抓取公开网页并返回可读文本（默认 30k 字符截断）。
 * 走 customTools 注册（每个会话可用），受权限门控 tool_call 钩子覆盖。
 * allowRanges 追加放行的 IPv4 CIDR（默认已放行 198.18.0.0/15 fake-ip 代理段）。
 */
export interface WebFetchOptions {
	allowRanges?: string[];
}

/** 可按文本处理的内容类型；其余（PDF/图片/压缩包等）不解码，避免乱码灌进上下文 */
const TEXTUAL_CONTENT_TYPE =
	/^text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|xhtml\+xml|javascript|x-javascript|ecmascript|yaml|x-yaml|x-www-form-urlencoded)/i;

/** github.com 的 blob 文件页重写到 raw 源（内容等价、噪音为零）；去查询串/锚点。
 *  ref 含斜杠（feature/x 类分支）时按 GitHub 同款贪心规则交给 raw 服务端解析。
 *  repo 根页不重写：HTML 抓取能同时拿到 README 与 stars/forks 等元数据。 */
function rewriteUrl(url: string): string {
	const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+?)(?:[?#].*)?$/.exec(url);
	if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}`;
	return url;
}

export function makeWebFetchTool(options: WebFetchOptions = {}): ToolDefinition<typeof webFetchParams> {
	const allowRanges = [FAKE_IP_CIDR, ...(options.allowRanges ?? []).map(parseCidr)];
	return {
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a public web page (http/https) and return its readable text content as markdown, with navigation/footer boilerplate stripped. Use for documentation, articles, and other public pages. GitHub file (blob) pages are fetched as raw source. Refuses private or internal addresses. Truncates content to maxChars characters. Binary content (PDF, images, archives) is not extracted.",
		promptSnippet: "webfetch({url})",
		parameters: webFetchParams,
		execute: async (_toolCallId, params, signal): Promise<AgentToolResult<WebFetchDetails>> => {
			const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
			const startUrl = await assertPublicUrl(rewriteUrl(params.url), allowRanges);
			let fetched: FetchResult;
			try {
				fetched = await fetchPublic(startUrl, signal, allowRanges);
			} catch (err) {
				// undici 用 signal.reason reject：用户取消为 AbortError，AbortSignal.timeout 为 TimeoutError
				if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
					throw new Error(
						signal?.aborted ? "webfetch aborted by user" : `webfetch timed out after ${TIMEOUT_MS / 1000}s`,
					);
				}
				throw err;
			}
			if (fetched.contentType && !TEXTUAL_CONTENT_TYPE.test(fetched.contentType)) {
				return {
					content: [
						{
							type: "text",
							text: `(binary content: ${fetched.contentType}, ${fetched.bytes} bytes fetched — not extracted; if you need this file, download it with bash and inspect it locally)`,
						},
					],
					details: {
						url: params.url,
						finalUrl: fetched.finalUrl,
						status: fetched.status,
						contentType: fetched.contentType,
						fetchedBytes: fetched.bytes,
						bytes: 0,
						truncated: false,
					},
				};
			}
			const isHtml = /text\/html|application\/xhtml\+xml/i.test(fetched.contentType);
			let text = isHtml ? htmlToText(fetched.text) : fetched.text;
			let truncated = false;
			if (text.length > maxChars) {
				text = `${text.slice(0, maxChars)}\n\n[truncated: ${maxChars} of ${text.length} characters]`;
				truncated = true;
			}
			return {
				content: [{ type: "text", text: text || "(empty page)" }],
				details: {
					url: params.url,
					finalUrl: fetched.finalUrl,
					status: fetched.status,
					contentType: fetched.contentType,
					fetchedBytes: fetched.bytes,
					bytes: Buffer.byteLength(text, "utf8"),
					truncated,
				},
			};
		},
	};
}
