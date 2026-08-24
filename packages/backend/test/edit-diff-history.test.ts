import { describe, expect, it } from "vitest";
import { toSessionMessages } from "../src/session/messages";

const PATCH = `--- src/a.ts
+++ src/a.ts
@@ -1,2 +1,3 @@
 keep
-drop
+add1
+add2
`;

describe("toSessionMessages：edit 历史回放提取 unified patch", () => {
	it("edit 的 toolResult.details.patch → SessionToolCall.diff", () => {
		const messages = toSessionMessages([
			{ role: "user", content: [{ type: "text", text: "改一下 a.ts" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "edit", arguments: { path: "src/a.ts", edits: [] } }],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				content: [{ type: "text", text: "Edited src/a.ts" }],
				details: { diff: "+1 ...", patch: PATCH, firstChangedLine: 2 },
				isError: false,
				timestamp: 3,
			},
		]);
		const assistant = messages.find((m) => m.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("expected assistant message");
		expect(assistant.tools[0]?.diff).toBe(PATCH);
	});

	it("error / 缺 details / patch 非字符串 均不写入 diff；非 edit 工具不写", () => {
		const base = [
			{ role: "user", content: [{ type: "text", text: "u" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc-err", name: "edit", arguments: { path: "a", edits: [] } },
					{ type: "toolCall", id: "tc-nodetails", name: "edit", arguments: { path: "b", edits: [] } },
					{ type: "toolCall", id: "tc-badtype", name: "edit", arguments: { path: "c", edits: [] } },
					{ type: "toolCall", id: "tc-write", name: "write", arguments: { path: "d", content: "x" } },
				],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "tc-err",
				content: [{ type: "text", text: "no match" }],
				details: { patch: PATCH },
				isError: true,
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "tc-nodetails",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 4,
			},
			{
				role: "toolResult",
				toolCallId: "tc-badtype",
				content: [{ type: "text", text: "ok" }],
				details: { patch: 42 },
				isError: false,
				timestamp: 5,
			},
			{
				role: "toolResult",
				toolCallId: "tc-write",
				content: [{ type: "text", text: "ok" }],
				details: { patch: PATCH },
				isError: false,
				timestamp: 6,
			},
		];
		const messages = toSessionMessages(base);
		const assistant = messages.find((m) => m.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("expected assistant message");
		for (const tool of assistant.tools) {
			expect(tool.diff).toBeUndefined();
		}
	});
});
