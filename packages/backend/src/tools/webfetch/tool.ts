import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { htmlToText } from "./html-to-text";
import { assertPublicUrl, type Cidr, FAKE_IP_CIDR, parseCidr } from "./ip-guard";

/**
 * 内置 webfetch 工具：抓取公开网页并返回可读文本（默认 30k 字符截断）。
 * 走 customTools 注册（每个会话可用），受权限门控 tool_call 钩子覆盖。
 * allowRanges 追加放行的 IPv4 CIDR（默认已放行 198.18.0.0/15 fake-ip 代理段）。
 */

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

export interface WebFetchOptions {
	allowRanges?: string[];
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
