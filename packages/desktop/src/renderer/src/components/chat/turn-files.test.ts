import { deriveTurnChanges, type UIMessage, type UIToolCall } from "@percho/shared";
import { describe, expect, it } from "vitest";

/** noUncheckedIndexedAccess 下的数组取值断言 */
function at<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) throw new Error(`index ${i} out of range`);
	return v;
}

const PATCH_A = `--- src/a.ts
+++ src/a.ts
@@ -1,2 +1,3 @@
 keep
-drop
+add1
+add2
`;

const PATCH_A2 = `--- src/a.ts
+++ src/a.ts
@@ -5,1 +5,2 @@
 ctx
+again
`;

let toolKey = 0;
function tool(name: string, args: unknown, extra: Partial<UIToolCall> = {}): UIToolCall {
	return {
		key: `k${toolKey++}`,
		id: `id${toolKey}`,
		name,
		args: JSON.stringify(args),
		output: "",
		state: "done",
		...extra,
	};
}

function user(id: string): UIMessage {
	return { kind: "user", id, text: "u", images: [], timestamp: 0 };
}

function assistant(id: string, tools: UIToolCall[], text = "a"): UIMessage {
	return { kind: "assistant", id, text, thinking: "", tools, timestamp: 0 };
}

describe("deriveTurnChanges", () => {
	it("空消息 / 无变更 → []", () => {
		expect(deriveTurnChanges([])).toEqual([]);
		expect(deriveTurnChanges([user("u1"), assistant("a1", [tool("read", { path: "x" })])])).toEqual([]);
	});

	it("单轮 edit：path/统计/patch 段", () => {
		const t = tool("edit", { path: "src/a.ts", edits: [] }, { diff: PATCH_A });
		const turns = deriveTurnChanges([user("u1"), assistant("a1", [t])]);
		expect(turns).toHaveLength(1);
		expect(at(turns, 0).turnIndex).toBe(0);
		expect(at(turns, 0).totalAdded).toBe(2);
		expect(at(turns, 0).totalRemoved).toBe(1);
		const f = at(at(turns, 0).files, 0);
		expect(f.path).toBe("src/a.ts");
		expect(f.sections).toHaveLength(1);
		expect(at(f.sections, 0)).toMatchObject({ kind: "edit", toolCallKey: t.key, patch: PATCH_A });
	});

	it("write：全量 + 行伪 diff，removed 恒 0；空 content 跳过", () => {
		const w = tool("write", { path: "src/new.ts", content: "l1\nl2\nl3" });
		const turns = deriveTurnChanges([user("u1"), assistant("a1", [w])]);
		expect(at(at(turns, 0).files, 0)).toMatchObject({ path: "src/new.ts", added: 3, removed: 0 });
		expect(at(at(at(turns, 0).files, 0).sections, 0)).toMatchObject({ kind: "write", content: "l1\nl2\nl3" });
		// 空 content 不产生变更
		const wEmpty = tool("write", { path: "src/empty.ts", content: "" });
		expect(deriveTurnChanges([user("u1"), assistant("a1", [wEmpty])])).toEqual([]);
	});

	it("轮次边界：user 消息切轮，多轮各自汇总", () => {
		const messages = [
			user("u1"),
			assistant("a1", [tool("edit", { path: "src/a.ts" }, { diff: PATCH_A })]),
			user("u2"),
			assistant("a2", [tool("write", { path: "src/b.ts", content: "x" })]),
		];
		const turns = deriveTurnChanges(messages);
		expect(turns).toHaveLength(2);
		expect(at(turns, 0).turnIndex).toBe(0);
		expect(at(turns, 1).turnIndex).toBe(1);
		expect(at(at(turns, 1).files, 0).path).toBe("src/b.ts");
	});

	it("同轮同文件多次 edit：合并为一个文件、多 section、统计累加", () => {
		const messages = [
			user("u1"),
			assistant("a1", [tool("edit", { path: "src/a.ts" }, { diff: PATCH_A })]),
			assistant("a2", [tool("edit", { path: "src/a.ts" }, { diff: PATCH_A2 })]),
		];
		const turns = deriveTurnChanges(messages);
		expect(at(turns, 0).files).toHaveLength(1);
		expect(at(at(turns, 0).files, 0).sections).toHaveLength(2);
		expect(at(at(turns, 0).files, 0)).toMatchObject({ added: 3, removed: 1 });
	});

	it("error 工具 / 缺 diff 的 edit / 无 patch 变更(0/0) / 垃圾 args 全部跳过", () => {
		const messages = [
			user("u1"),
			assistant("a1", [
				tool("edit", { path: "src/a.ts" }, { diff: PATCH_A, state: "error" }),
				tool("edit", { path: "src/no-patch.ts" }),
				tool("edit", { path: "src/noop.ts" }, { diff: "--- a\n+++ b\n" }),
			]),
			assistant("a2", [
				{ ...tool("edit", {}), args: "not json{{{" },
				{ ...tool("write", {}), args: JSON.stringify({ content: "no path" }) },
			]),
		];
		expect(deriveTurnChanges(messages)).toEqual([]);
	});

	it("纯工具轮（assistant 无正文）也产出 TurnChanges；无 assistant 的轮不产出", () => {
		const messages = [
			user("u1"),
			assistant("a1", [tool("edit", { path: "src/a.ts" }, { diff: PATCH_A })], ""),
			user("u2"), // 第二轮没有任何 assistant 回复
		];
		const turns = deriveTurnChanges(messages);
		expect(turns).toHaveLength(1);
		expect(at(turns, 0).turnIndex).toBe(0);
	});

	it("首条 user 之前的 assistant 不计（防御）", () => {
		const messages = [assistant("a0", [tool("edit", { path: "src/a.ts" }, { diff: PATCH_A })]), user("u1")];
		expect(deriveTurnChanges(messages)).toEqual([]);
	});

	it("其他消息种类（system/image/subagent）不影响轮次与统计", () => {
		const messages = [
			user("u1"),
			{ kind: "system", id: "s1", text: "", timestamp: 0 } as UIMessage,
			assistant("a1", [tool("edit", { path: "src/a.ts" }, { diff: PATCH_A })]),
			{ kind: "image", id: "i1", images: [], paths: [], timestamp: 0 } as UIMessage,
		];
		const turns = deriveTurnChanges(messages);
		expect(turns).toHaveLength(1);
		expect(at(at(turns, 0).files, 0).path).toBe("src/a.ts");
	});
});
