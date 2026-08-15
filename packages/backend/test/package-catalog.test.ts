import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, parseCatalogHtml } from "../src/packages/catalog";

/** 按 pi.dev/packages 真实卡片结构构造的精简 fixture（字段位置/类名与线上一致） */
function card(attrs: string, body: string): string {
	return `<article class="surface-panel content-card" data-package-card="true" ${attrs}>${body}</article>`;
}

function body(desc: string, author: string, badges: string): string {
	return (
		`<div class="packages-card-body">` +
		`<h3 class="packages-name"><a href="/packages/x">x</a></h3>` +
		`<p class="packages-desc">${desc}</p>` +
		`<div class="packages-meta"><span>${author}</span><span>12.3K/mo</span><span>4d ago</span></div>` +
		`<div class="packages-badges">${badges}</div>` +
		`</div>`
	);
}

const FIXTURE =
	`<html><body><p>1-50 / 5,472</p>` +
	card(
		`data-package-name="pi-lens" ` +
			`data-package-search="pi-lens real-time code feedback apmantza extension" ` +
			`data-package-types="extension" data-package-downloads="40900" data-package-date="1780000000000"`,
		body(
			"Real-time code feedback for pi — LSP, linters &amp; formatters",
			"apmantza",
			`<span class="meta-chip packages-badge" data-type="extension">extension</span>`,
		),
	) +
	card(
		`data-package-name="@juicesharp/rpiv-todo" ` +
			`data-package-types="extension skill" data-package-downloads="43100" data-package-date="1780100000000"`,
		body(
			"A todo list for the model, rendered as a live overlay &quot;surviving&quot; /reload",
			"juicesharp",
			`<span data-type="extension">extension</span><span data-type="skill">skill</span>`,
		),
	) +
	card(
		`data-package-name="bare-pkg" data-package-types="" data-package-downloads="7" data-package-date="0"`,
		body("", "someone", ""),
	) +
	`</body></html>`;

describe("parseCatalogHtml", () => {
	it("解析卡片名称/描述/作者/类型/下载量/时间", () => {
		const { packages } = parseCatalogHtml(FIXTURE);
		expect(packages).toHaveLength(3);

		const lens = packages[0];
		expect(lens.name).toBe("pi-lens");
		expect(lens.description).toBe("Real-time code feedback for pi — LSP, linters & formatters");
		expect(lens.author).toBe("apmantza");
		expect(lens.types).toEqual(["extension"]);
		expect(lens.downloads).toBe(40900);
		expect(lens.updatedAt).toBe(1780000000000);
		expect(lens.installSource).toBe("npm:pi-lens");
	});

	it("多类型包按空格拆分；引号实体解码", () => {
		const { packages } = parseCatalogHtml(FIXTURE);
		expect(packages[1].types).toEqual(["extension", "skill"]);
		expect(packages[1].description).toContain('"surviving"');
		expect(packages[1].installSource).toBe("npm:@juicesharp/rpiv-todo");
	});

	it("无类型标记时回退为 package", () => {
		const { packages } = parseCatalogHtml(FIXTURE);
		expect(packages[2].types).toEqual(["package"]);
	});

	it("解析分页总数（容忍千分位逗号）", () => {
		const { total } = parseCatalogHtml(FIXTURE);
		expect(total).toBe(5472);
	});

	it("无分页文案时总数回退为卡片数", () => {
		const { total } = parseCatalogHtml("<div>no cards</div>");
		expect(total).toBe(0);
	});

	it("结构不符时不抛出、返回空列表", () => {
		expect(parseCatalogHtml("garbage").packages).toEqual([]);
	});
});

describe("decodeHtmlEntities", () => {
	it("覆盖常见实体", () => {
		expect(decodeHtmlEntities("a &amp; b &lt;c&gt; &quot;q&quot; &#39;s&#39; &nbsp;x")).toBe(
			`a & b <c> "q" 's'  x`,
		);
	});
});
