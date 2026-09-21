import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * renderer 模块图不许有环（工程纪律，见 docs/INDEX.md 硬约束 / PITFALLS）。
 *
 * 为什么值得一条测试：有环时「某个模块体在谁的 import 过程中执行」不确定，模块级副作用会读到
 * 尚未求值的绑定 —— 2026-09-21 的会话目录写穿订阅就因此炸过一次（`stores/projects.ts` 底部的
 * `useSessionsStore.subscribe` 在「sessions 先进」的入口下拿到 undefined）；当时环
 * `stores/projects → stores/sessions → stores/ui-preferences → lib/sidebar-groups → stores/projects`
 * 的成因只是一条 3 行纯函数（`toggleInList`）挂错了层。环本身没炸是因为入口顺序碰巧对了 —— 这类
 * 潜伏问题靠 reviewer 眼睛看不出来，交给它守。
 *
 * 判定口径：只看 `src/renderer/src` 下的相对 import（含 `import type` 与 `import "x"` 副作用导入；
 * 类型环同样说明分层乱了）。外部包（`@percho/shared` 等）不参与。
 */
const ROOT = resolve(import.meta.dirname);
const SOURCE_RE = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

function listSources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return listSources(path);
		return /\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts") ? [path] : [];
	});
}

function edgesOf(file: string): string[] {
	const found = new Set<string>();
	for (const match of readFileSync(file, "utf8").matchAll(SOURCE_RE)) {
		const spec = match[1] ?? match[2];
		if (!spec?.startsWith(".")) continue;
		const base = resolve(dirname(file), spec);
		for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
			try {
				if (statSync(candidate).isFile()) found.add(candidate);
			} catch {
				// 不是文件（目录/不存在）→ 继续试下一个候选
			}
		}
	}
	return [...found];
}

it("renderer 的 import 图无环（有环 = 模块体执行顺序不确定，模块级副作用会踩未初始化绑定）", () => {
	const sources = listSources(ROOT);
	const graph = new Map(sources.map((file) => [file, edgesOf(file)]));
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const cycles: string[] = [];

	function visit(node: string): void {
		state.set(node, "visiting");
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			if (!graph.has(next)) continue;
			if (state.get(next) === "visiting") {
				cycles.push([...stack.slice(stack.indexOf(next)), next].map((p) => relative(ROOT, p)).join(" → "));
				continue;
			}
			if (!state.has(next)) visit(next);
		}
		stack.pop();
		state.set(node, "done");
	}

	for (const file of sources) if (!state.has(file)) visit(file);
	expect(cycles).toEqual([]);
});

describe("本测试自己的守卫（防它自己失效）", () => {
	it("扫到的文件数与依赖解析都非空（否则「0 环」是假绿）", () => {
		const sources = listSources(ROOT);
		expect(sources.length).toBeGreaterThan(50);
		const withEdges = sources.filter((file) => edgesOf(file).length > 0);
		expect(withEdges.length).toBeGreaterThan(20);
	});
});
