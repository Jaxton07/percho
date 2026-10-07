import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 字号守护测试（spec D10 / plan 阶段 1）。
 *
 * 这一组测试是「硬编码字号会悄悄长回来」的看门人：改动 typography.css / globals.css / 组件 class
 * 时，只要有硬编码字号混进来就变红。它不测渲染（那是 `scripts/check-font-size.mjs compare` 的活）。
 */
const stylesDir = fileURLToPath(new URL(".", import.meta.url));
const srcDir = fileURLToPath(new URL("../", import.meta.url));
const typography = readFileSync(join(stylesDir, "typography.css"), "utf8");
const globals = readFileSync(join(stylesDir, "globals.css"), "utf8");

/** 全部合法 token → 它的 px 值（名字规则：去掉小数点，如 text-ui-105 = 10.5px） */
const TOKEN_PX = {
	"text-ui-10": 10,
	"text-ui-105": 10.5,
	"text-ui-11": 11,
	"text-ui-115": 11.5,
	"text-ui-12": 12,
	"text-ui-125": 12.5,
	"text-ui-13": 13,
	"text-ui-135": 13.5,
	"text-ui-14": 14,
	"text-ui-15": 15,
	"text-ui-16": 16,
	"text-ui-18": 18,
	"text-ui-19": 19,
};

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(tsx|ts|css)$/.test(entry.name)) out.push(full);
	}
	return out;
}

describe("字号 token（typography.css）", () => {
	it("token 集合与 px 值一一对应，没有多写也没有少写", () => {
		const matches = [
			...typography.matchAll(
				/\.(text-ui-\d+)\s*\{\s*font-size:\s*calc\(([\d.]+)px \* var\(--fs-ui-scale, 1\)\);/g,
			),
		];
		const actual = Object.fromEntries(matches.map((m) => [m[1], Number(m[2])]));
		expect(actual).toEqual(TOKEN_PX);
	});

	it("每个 font-size 都是 calc(px * var(--fs-ui-scale, 1))，没有裸 px", () => {
		const sizes = [...typography.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
		expect(sizes.length).toBe(Object.keys(TOKEN_PX).length);
		for (const size of sizes) {
			expect(size).toMatch(/^calc\([\d.]+px \* var\(--fs-ui-scale, 1\)\)$/);
		}
	});

	it("两个乘数变量的兜底值都是 1（默认档 = 迁移前现状）", () => {
		expect(typography).toMatch(/--fs-ui-scale: 1;/);
		expect(typography).toMatch(/--fs-code-scale: 1;/);
	});
});

describe("globals.css", () => {
	it("typography.css 的 @import 必须排在 tailwindcss 之后（层序硬要求）", () => {
		const tailwind = globals.indexOf('@import "tailwindcss";');
		const typographyImport = globals.indexOf('@import "./typography.css";');
		expect(tailwind).toBeGreaterThanOrEqual(0);
		expect(typographyImport).toBeGreaterThan(tailwind);
		// 反过来会让 base 层（preflight 的 font: inherit）压住 utilities 层 —— 按钮上尤其明显
	});

	it("每一处 font-size 都走 calc(var) 或白名单里的 0", () => {
		const sizes = [...globals.matchAll(/^\s*font-size:\s*([^;]+);/gm)].map((m) => m[1].trim());
		expect(sizes.length).toBeGreaterThan(40); // 迁移前实测 46 处，别让整段被误删
		for (const size of sizes) {
			expect(size === "0" || /^calc\([\d.]+px \* var\(--fs-(ui|code)-scale, 1\)\)$/.test(size)).toBe(true);
		}
	});

	it("绝对行高只在三处，且都跟着字号一起缩（否则大档会裁切）", () => {
		// 只看绝对量（px / rem）：无单位倍数（如 leading-x）天然随字号缩，不用管
		const lineHeights = [...globals.matchAll(/^\s*line-height:\s*([^;]+);/gm)]
			.map((m) => m[1].trim())
			.filter((value) => /px|rem/.test(value));
		expect(lineHeights).toEqual([
			"calc(20px * var(--fs-ui-scale, 1))",
			"calc(20px * var(--fs-code-scale, 1))",
			"calc(18px * var(--fs-code-scale, 1))",
		]);
	});
});

describe("组件里的字号", () => {
	/** 只看产品源码：测试文件里的 CSS 片段/String 面量（如 parse-patch 的样例 patch）不是界面字号，且本文件自己就写着这些模式 */
	const sources = walk(srcDir)
		.filter((file) => /\.(tsx|ts)$/.test(file))
		.filter((file) => !/\.test\.tsx?$/.test(file))
		.map((file) => ({ file, text: readFileSync(file, "utf8") }));

	it("不许再写 text-[Npx]", () => {
		const offenders = sources.flatMap(({ file, text }) =>
			[...text.matchAll(/text-\[[\d.]+px\]/g)].map((m) => `${file}: ${m[0]}`),
		);
		expect(offenders).toEqual([]);
	});

	it("不许再写 rem 基类 text-xs / text-sm / text-lg", () => {
		const offenders = sources.flatMap(({ file, text }) =>
			[...text.matchAll(/\btext-(xs|sm|lg)\b/g)].map((m) => `${file}: ${m[0]}`),
		);
		expect(offenders).toEqual([]);
	});

	it("字号只用 text-ui-* token（顺手把写死的 font-size 也拦住）", () => {
		const offenders = sources.flatMap(({ file, text }) =>
			[...text.matchAll(/font-size:\s*[\d.]+px/g)].map((m) => `${file}: ${m[0]}`),
		);
		expect(offenders).toEqual([]);
	});
});
