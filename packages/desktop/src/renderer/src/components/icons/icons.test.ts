import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 图标 path 数据回归测试：生产环境曾因 ForkIcon 末尾 s 段缺一个参数
 * （`…37.12999821 37.1299982z`，s 每组需 4 个数）被 Chromium 报
 * `<path> attribute d: Expected number` 且该段被丢弃。
 * 这里对 icons/index.tsx 中所有 d 属性做严格的 SVG path 语法校验，防止残缺数据再次混入。
 */

const ARITY: Record<string, number> = {
	M: 2,
	L: 2,
	H: 1,
	V: 1,
	C: 6,
	S: 4,
	Q: 4,
	T: 2,
	A: 7,
	Z: 0,
};

/** 按 W3C SVG path BNF 做令牌化，校验每条命令（含隐式重复）的参数数完整；返回错误描述或 null */
function validatePathData(d: string): string | null {
	const numRe = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
	let pos = 0;
	let cmd: string | null = null;
	let count = 0;
	let need = 0;
	const skipSep = (p: number) => {
		while (p < d.length && /[\s,]/.test(d.charAt(p))) p++;
		return p;
	};
	const ctx = (p: number) => `…${d.slice(Math.max(0, p - 20), p + 20)}…`;
	pos = skipSep(pos);
	while (pos < d.length) {
		const ch = d.charAt(pos);
		if (/[AaCcHhLlMmQqSsTtVvZz]/.test(ch)) {
			if (cmd && need > 0 && count % need !== 0) {
				return `命令 ${cmd} 参数不完整（${count % need}/${need}）: ${ctx(pos)}`;
			}
			cmd = ch;
			count = 0;
			const arity = ARITY[ch.toUpperCase()];
			if (arity === undefined) return `未知命令 ${ch}: ${ctx(pos)}`;
			need = arity;
			pos = skipSep(pos + 1);
			if (ch === "z" || ch === "Z") cmd = null;
			continue;
		}
		if (!cmd) return `数字前缺少命令: ${ctx(pos)}`;
		numRe.lastIndex = pos;
		const m = numRe.exec(d);
		if (!m || m.index !== pos) return `无法解析数字: ${ctx(pos)}`;
		count++;
		pos = skipSep(pos + m[0].length);
	}
	if (cmd && need > 0 && count % need !== 0) {
		return `命令 ${cmd} 结尾参数不完整（${count % need}/${need}）: ${ctx(d.length)}`;
	}
	return null;
}

const source = readFileSync(fileURLToPath(new URL("./index.tsx", import.meta.url)), "utf8");
const pathDataList = [...source.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1] ?? "");

describe("icons/index.tsx 内联 SVG path 数据", () => {
	it("至少采集到一批 path（防止正则失效后测试空转）", () => {
		expect(pathDataList.length).toBeGreaterThan(10);
	});

	it("所有 d 属性均符合 SVG path 语法（命令参数数完整）", () => {
		const errors = pathDataList
			.map((d, i) => {
				const err = validatePathData(d);
				return err ? `第 ${i + 1} 个 path: ${err}` : null;
			})
			.filter(Boolean);
		expect(errors).toEqual([]);
	});
});
