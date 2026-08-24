import { parsePatch, patchStat } from "@percho/shared";
import { describe, expect, it } from "vitest";

/** noUncheckedIndexedAccess 下的数组取值断言 */
function at<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`index ${i} out of range`);
	return v;
}

/** 真实 trace 样本（2026-08-24，edit 工具 details.patch 原文截取） */
const REAL_PATCH = `--- .local/design/ux/turn_diff/index.html
+++ .local/design/ux/turn_diff/index.html
@@ -145,8 +145,9 @@
 \tborder-radius: 16px; padding: 9px 14px; font-size: 13.5px; white-space: pre-wrap;
 }
-.assistant p { font-size: 13.5px; color: var(--ink-2); margin: 0; }
+.assistant p { font-size: 13.5px; color: var(--ink-2); margin: 0; }
+.assistant code { font-family: var(--mono); font-size: 12px; }
 .assistant p + p { margin-top: 4px; }
`;

const MULTI_HUNK = `--- a.ts
+++ a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-old line
+new line
+another
 const b = 2;
@@ -10,2 +11,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
`;

describe("parsePatch", () => {
	it("单 hunk：行分类与双行号递进", () => {
		const hunks = parsePatch(REAL_PATCH);
		expect(hunks).toHaveLength(1);
		const h = at(hunks, 0);
		expect(h.oldStart).toBe(145);
		expect(h.newStart).toBe(145);
		expect(h.header).toBe("@@ -145,8 +145,9 @@");
		const kinds = h.lines.map((l) => l.kind);
		expect(kinds).toEqual(["ctx", "ctx", "del", "add", "add", "ctx"]);
		// ctx 双行号；del 只有 oldNo；add 只有 newNo
		expect(at(h.lines, 0)).toMatchObject({ oldNo: 145, newNo: 145 });
		expect(at(h.lines, 2)).toMatchObject({ kind: "del", oldNo: 147, newNo: null });
		expect(at(h.lines, 3)).toMatchObject({ kind: "add", oldNo: null, newNo: 147 });
		expect(at(h.lines, 4)).toMatchObject({ kind: "add", oldNo: null, newNo: 148 });
		expect(at(h.lines, 5)).toMatchObject({ kind: "ctx", oldNo: 148, newNo: 149 });
		// 行内容不含前缀
		expect(at(h.lines, 3).text.startsWith("+")).toBe(false);
	});

	it("多 hunk：各自独立编号起点", () => {
		const hunks = parsePatch(MULTI_HUNK);
		expect(hunks).toHaveLength(2);
		expect(at(hunks, 1).oldStart).toBe(10);
		expect(at(hunks, 1).newStart).toBe(11);
		expect(at(at(hunks, 1).lines, 0)).toMatchObject({ oldNo: 10, newNo: 11 });
	});

	it("hunk 头带 section 标题也能解析", () => {
		const hunks = parsePatch(`--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@ function foo() {\n-old\n+new\n`);
		expect(hunks).toHaveLength(1);
		expect(at(hunks, 0).header).toContain("function foo()");
	});

	it("\\ No newline at end of file 标记行被忽略", () => {
		const hunks = parsePatch(
			`--- a\n+++ a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n`,
		);
		expect(at(hunks, 0).lines).toHaveLength(2);
	});

	it("末尾换行不产生幻影 ctx 行", () => {
		const hunks = parsePatch(REAL_PATCH);
		const lines = at(hunks, 0).lines;
		const last = at(lines, lines.length - 1);
		expect(last.text).toBe(".assistant p + p { margin-top: 4px; }");
	});

	it("垃圾输入 / 空串 / 无 hunk → []，不抛", () => {
		expect(parsePatch("")).toEqual([]);
		expect(parsePatch("not a patch at all")).toEqual([]);
		expect(parsePatch("--- a\n+++ b\n")).toEqual([]);
		expect(parsePatch("@@ 不是数字 @@\n+x\n")).toEqual([]);
	});
});

describe("patchStat", () => {
	it("计数排除 ---/+++ 文件头", () => {
		expect(patchStat(REAL_PATCH)).toEqual({ added: 2, removed: 1 });
	});
	it("多 hunk 合计", () => {
		expect(patchStat(MULTI_HUNK)).toEqual({ added: 3, removed: 2 });
	});
	it("空串/垃圾 → 0/0", () => {
		expect(patchStat("")).toEqual({ added: 0, removed: 0 });
		expect(patchStat("garbage")).toEqual({ added: 0, removed: 0 });
	});
});
