import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertPublicUrl,
	FAKE_IP_CIDR,
	htmlToText,
	ipInCidr,
	isPublicIp,
	makeWebFetchTool,
	parseCidr,
} from "../src/tools/webfetch";

const PUBLIC_ADDR = [{ address: "1.2.3.4", family: 4 as const }];

function stubDns(resolver: (hostname: string) => { address: string; family: number }[] | undefined) {
	return vi.spyOn(dns.promises, "lookup").mockImplementation(async (hostname: string) => {
		const result = resolver(hostname);
		if (!result) throw new Error(`ENOTFOUND ${hostname}`);
		return result;
	});
}

describe("isPublicIp", () => {
	it("公网 IPv4/IPv6 放行", () => {
		expect(isPublicIp("1.2.3.4")).toBe(true);
		expect(isPublicIp("8.8.8.8")).toBe(true);
		expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
		expect(isPublicIp("2001:4860:4860::8888")).toBe(true);
	});

	it("私网/保留段拦截", () => {
		expect(isPublicIp("10.0.0.1")).toBe(false);
		expect(isPublicIp("172.16.0.1")).toBe(false);
		expect(isPublicIp("172.31.255.255")).toBe(false);
		expect(isPublicIp("192.168.1.1")).toBe(false);
		expect(isPublicIp("127.0.0.1")).toBe(false);
		expect(isPublicIp("169.254.169.254")).toBe(false);
		expect(isPublicIp("100.64.0.1")).toBe(false);
		expect(isPublicIp("224.0.0.1")).toBe(false);
		expect(isPublicIp("0.0.0.0")).toBe(false);
		expect(isPublicIp("::1")).toBe(false);
		expect(isPublicIp("::")).toBe(false);
		expect(isPublicIp("fe80::1")).toBe(false);
		expect(isPublicIp("fd00::1")).toBe(false);
		expect(isPublicIp("::ffff:7f00:1")).toBe(false);
		expect(isPublicIp("::ffff:102:304")).toBe(true);
		expect(isPublicIp("::ffff:0:c612:2d")).toBe(true); // 198.18.0.45 非私网（保留段由 FAKE_IP_CIDR 单独放行）
	});

	it("IPv6 组播与内嵌 v4 的转换形式", () => {
		expect(isPublicIp("ff02::1")).toBe(false); // ff00::/8 组播
		expect(isPublicIp("64:ff9b::7f00:1")).toBe(false); // NAT64 内嵌 127.0.0.1
		expect(isPublicIp("64:ff9b::127.0.0.1")).toBe(false); // 点分形式
		expect(isPublicIp("64:ff9b::102:304")).toBe(true); // NAT64 内嵌公网 v4
		expect(isPublicIp("::7f00:1")).toBe(false); // v4-compatible ::/96 = 127.0.0.1
		expect(isPublicIp("::102:304")).toBe(true); // v4-compatible 内嵌公网 v4
	});
});

describe("ipInCidr / parseCidr", () => {
	it("CIDR 匹配与边界", () => {
		const cidr = parseCidr("10.0.0.0/8");
		expect(ipInCidr("10.1.2.3", cidr)).toBe(true);
		expect(ipInCidr("11.0.0.1", cidr)).toBe(false);
		expect(ipInCidr("::ffff:10.0.0.1", cidr)).toBe(true);
		expect(ipInCidr("2001:4860::1", cidr)).toBe(false);
	});

	it("fake-ip 段命中 198.18/15（含十六进制 v4-mapped 形式）", () => {
		expect(ipInCidr("198.18.0.45", FAKE_IP_CIDR)).toBe(true);
		expect(ipInCidr("::ffff:198.18.0.45", FAKE_IP_CIDR)).toBe(true);
		expect(ipInCidr("::ffff:0:c612:2d", FAKE_IP_CIDR)).toBe(true);
		expect(ipInCidr("198.19.255.255", FAKE_IP_CIDR)).toBe(true);
		expect(ipInCidr("198.20.0.1", FAKE_IP_CIDR)).toBe(false);
		expect(ipInCidr("127.0.0.1", FAKE_IP_CIDR)).toBe(false);
	});

	it("非法 CIDR 抛错", () => {
		expect(() => parseCidr("10.0.0.0/33")).toThrow(/Invalid/);
		expect(() => parseCidr("::1/64")).toThrow(/Invalid/);
		expect(() => parseCidr("10.0.0.0")).toThrow(/Invalid/);
	});
});

describe("htmlToText", () => {
	it("剥离 script/style/注释并折叠空白", () => {
		const html = `<html><head><style>body{color:red}</style></head><body>
			<!-- comment -->
			<script>alert(1)</script>
			<p>Hello   world</p>
		</body></html>`;
		expect(htmlToText(html)).toBe("Hello world");
	});

	it("链接转 [text](href)，代码块包反引号", () => {
		const html = `<p>See <a href="https://example.com">the docs</a>:</p>
			<pre><code>const a = 1;</code></pre>
			<p>inline <code>code()</code> here</p>`;
		const text = htmlToText(html);
		expect(text).toContain("[the docs](https://example.com)");
		expect(text).toContain("```\nconst a = 1;\n```");
		expect(text).toContain("`code()`");
	});

	it("实体解码", () => {
		expect(htmlToText("&lt;div&gt; &amp; &#39;quoted&#39; &nbsp; end")).toBe("<div> & 'quoted' end");
	});

	it("块级标签产生换行且标题/段落可见", () => {
		const text = htmlToText("<h1>Title</h1><p>First</p><p>Second</p>");
		expect(text).toContain("Title");
		expect(text).toContain("First\nSecond");
	});

	it("标题与列表转 markdown", () => {
		const text = htmlToText("<h2>Setup</h2><ul><li>First</li><li>Second</li></ul>");
		expect(text).toContain("## Setup");
		expect(text).toContain("- First\n- Second");
	});

	it("优先 main/article 主区域，剥离页面框架噪音", () => {
		const body = `<h1>Docs</h1><p>Real content</p><p>${"substantial paragraph content. ".repeat(8)}</p><footer>Page footer</footer>`;
		const html = `<html><body>
			<nav>Platform Solutions Enterprise</nav>
			<header>Site chrome</header>
			<main>${body}</main>
			<footer>Site footer links</footer>
		</body></html>`;
		const text = htmlToText(html);
		expect(text).toContain("Real content");
		expect(text).not.toContain("Platform Solutions");
		expect(text).not.toContain("Site chrome");
		expect(text).not.toContain("Site footer links");
		expect(text).not.toContain("Page footer");
	});

	it("无主区域时剥离 nav/footer 并保留正文", () => {
		expect(htmlToText("<body><nav>Menu</nav><p>Body text</p><footer>Links</footer></body>")).toBe(
			"Body text",
		);
	});

	it("空 main（SPA 壳）回退全文", () => {
		const html = '<body><main id="root"></main><p>fallback content here</p></body>';
		expect(htmlToText(html)).toContain("fallback content here");
	});

	it("移除 Skip to content 辅助链接", () => {
		expect(htmlToText('<a href="#content">Skip to content</a><p>Hi</p>')).toBe("Hi");
	});
});

describe("assertPublicUrl", () => {
	afterEach(() => vi.restoreAllMocks());

	it("拒绝非 http(s) 协议与带凭证 URL", async () => {
		await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/only supports http/);
		await expect(assertPublicUrl("https://user:pass@example.com/")).rejects.toThrow(/credentials/);
	});

	it("拒绝私网 IP 字面量（不查 DNS）", async () => {
		const lookup = vi.spyOn(dns.promises, "lookup");
		await expect(assertPublicUrl("http://127.0.0.1/x")).rejects.toThrow(/private address/);
		await expect(assertPublicUrl("http://192.168.1.1/")).rejects.toThrow(/private address/);
		expect(lookup).not.toHaveBeenCalled();
	});

	it("host 解析到私网地址时拦截", async () => {
		stubDns((host) => (host === "metadata.internal" ? [{ address: "10.0.0.2", family: 4 }] : PUBLIC_ADDR));
		await expect(assertPublicUrl("http://metadata.internal/")).rejects.toThrow(/non-public address/);
		await expect(assertPublicUrl("http://public.example.com/docs")).resolves.toBeInstanceOf(URL);
	});

	it("allowRanges 放行指定私网段（默认仍拦截）", async () => {
		stubDns(() => [{ address: "10.0.0.2", family: 4 }]);
		await expect(assertPublicUrl("http://example.com/")).rejects.toThrow(/non-public address/);
		await expect(assertPublicUrl("http://example.com/", [parseCidr("10.0.0.0/8")])).resolves.toBeInstanceOf(
			URL,
		);
		// 其他私网段不放行
		await expect(assertPublicUrl("http://example.com/", [FAKE_IP_CIDR])).rejects.toThrow(
			/non-public address/,
		);
	});

	it("解析失败报错", async () => {
		stubDns(() => undefined);
		await expect(assertPublicUrl("http://does-not-exist.example/")).rejects.toThrow(/Could not resolve/);
	});
});

describe("makeWebFetchTool", () => {
	const tool = makeWebFetchTool();

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("抓取 HTML 页面并转为文本", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					"<html><body><h1>Docs</h1><p>Hello <a href='https://e.com'>link</a></p></body></html>",
					{
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
					},
				);
			}),
		);
		const result = await tool.execute(
			"id1",
			{ url: "https://public.example.com/docs" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Docs");
		expect(text).toContain("[link](https://e.com)");
		expect(result.details).toMatchObject({ url: "https://public.example.com/docs", status: 200 });
	});

	it("纯文本与 JSON 原样返回", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response('{"ok": true}', {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const result = await tool.execute(
			"id2",
			{ url: "https://public.example.com/api" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toBe('{"ok": true}');
	});

	it("超过 maxChars 截断并标记", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response("x".repeat(5000), { status: 200, headers: { "content-type": "text/plain" } });
			}),
		);
		const result = await tool.execute(
			"id3",
			{ url: "https://public.example.com/", maxChars: 1000 },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeLessThanOrEqual(1100);
		expect(text).toContain("[truncated:");
		expect(result.details.truncated).toBe(true);
	});

	it("跟随公网重定向，拒绝跳向内网", async () => {
		stubDns((host) => {
			if (host === "internal.example.com") return [{ address: "10.0.0.5", family: 4 }];
			return PUBLIC_ADDR;
		});
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.href;
			if (url === "https://public.example.com/start") {
				return new Response(null, {
					status: 302,
					headers: { location: "https://internal.example.com/secret" },
				});
			}
			if (url === "https://public.example.com/page") {
				return new Response("landed", { status: 200, headers: { "content-type": "text/plain" } });
			}
			throw new Error(`unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			tool.execute(
				"id4",
				{ url: "https://public.example.com/start" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/non-public address/);

		const ok = await tool.execute(
			"id5",
			{ url: "https://public.example.com/page" },
			undefined,
			undefined,
			undefined as never,
		);
		expect((ok.content[0] as { text: string }).text).toBe("landed");
	});

	it("非 2xx 抛错", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
			}),
		);
		await expect(
			tool.execute(
				"id6",
				{ url: "https://public.example.com/missing" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/HTTP 404/);
	});

	it("二进制内容不解码，返回明确提示", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
						status: 200,
						headers: { "content-type": "application/pdf" },
					}),
			),
		);
		const result = await tool.execute(
			"id7",
			{ url: "https://public.example.com/f.pdf" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("binary content: application/pdf");
		expect(result.details.fetchedBytes).toBe(4);
		expect(result.details.bytes).toBe(0);
	});

	it("超时（TimeoutError）给出友好错误", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("The operation timed out", "TimeoutError");
			}),
		);
		await expect(
			tool.execute(
				"id8",
				{ url: "https://public.example.com/slow" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/timed out after 20s/);
	});

	it("用户中止（AbortError + 已中止 signal）给出友好错误", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("This operation was aborted", "AbortError");
			}),
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			tool.execute(
				"id9",
				{ url: "https://public.example.com/x" },
				controller.signal,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/aborted by user/);
	});

	it("响应体超过 2MB 按字节截断", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("x".repeat(3 * 1024 * 1024), {
						status: 200,
						headers: { "content-type": "text/plain" },
					}),
			),
		);
		const result = await tool.execute(
			"id10",
			{ url: "https://public.example.com/big", maxChars: 200_000 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details.fetchedBytes).toBe(2 * 1024 * 1024);
		expect(result.details.truncated).toBe(true);
	});

	it("重定向缺 Location 报错；304 不再当重定向", async () => {
		stubDns(() => PUBLIC_ADDR);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = typeof input === "string" ? input : input.href;
				if (url.endsWith("/noloc")) return new Response(null, { status: 302 });
				if (url.endsWith("/cached")) return new Response(null, { status: 304 });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		await expect(
			tool.execute(
				"id11",
				{ url: "https://public.example.com/noloc" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/redirect without Location/);
		await expect(
			tool.execute(
				"id12",
				{ url: "https://public.example.com/cached" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/HTTP 304/);
	});

	it("GitHub blob 页重写为 raw 源地址，details.url 保留原始输入", async () => {
		stubDns(() => PUBLIC_ADDR);
		const fetchMock = vi.fn(
			async () => new Response("# Guide\nhello", { status: 200, headers: { "content-type": "text/plain" } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const blobUrl = "https://github.com/owner/repo/blob/main/docs/guide.md#L10";
		const result = await tool.execute("id13", { url: blobUrl }, undefined, undefined, undefined as never);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.objectContaining({
				href: "https://raw.githubusercontent.com/owner/repo/main/docs/guide.md",
			}),
			expect.anything(),
		);
		expect(result.details.url).toBe(blobUrl);
		expect((result.content[0] as { text: string }).text).toContain("# Guide");
	});
});
