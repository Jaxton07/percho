import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { summarizeSubagentRun } from "../src/tools/subagent/summary";

function branch(messages: unknown[]) {
	return {
		getBranch: () =>
			messages.map((message, i) => ({
				type: "message",
				id: String(i),
				parentId: i ? String(i - 1) : null,
				timestamp: new Date().toISOString(),
				message,
			})) as SessionEntry[],
	};
}

describe("子代理运行事实", () => {
	it("edit/write 去重累加；bash 改动不计，失败命令单独计数", () => {
		const summary = summarizeSubagentRun(
			branch([
				{ role: "user", content: "task" },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "w", name: "write", arguments: { path: "a", content: "one\ntwo" } },
						{
							type: "toolCall",
							id: "e",
							name: "edit",
							arguments: { path: "a", oldText: "one", newText: "three" },
						},
						{ type: "toolCall", id: "b", name: "bash", arguments: { command: "echo hidden > other" } },
						{ type: "toolCall", id: "f", name: "bash", arguments: { command: "npm test" } },
					],
				},
				{ role: "toolResult", toolCallId: "w", toolName: "write", content: [], isError: false },
				{
					role: "toolResult",
					toolCallId: "e",
					toolName: "edit",
					content: [],
					isError: false,
					details: { patch: "@@ -1 +1 @@\n-one\n+three" },
				},
				{ role: "toolResult", toolCallId: "b", toolName: "bash", content: [], isError: false },
				{ role: "toolResult", toolCallId: "f", toolName: "bash", content: [], isError: true },
			]),
			30,
		);
		expect(summary).toMatchObject({
			changedFiles: [{ path: "a", added: 3, removed: 1 }],
			commands: [
				{ command: "echo hidden > other", isError: false },
				{ command: "npm test", isError: true },
			],
			failedCommands: 1,
			durationMs: 30,
		});
	});
	it("空分支与解析异常返回空事实", () => {
		for (const manager of [
			branch([]),
			{
				getBranch: () => {
					throw new Error("broken");
				},
			},
		])
			expect(summarizeSubagentRun(manager, 12)).toEqual({
				changedFiles: [],
				commands: [],
				failedCommands: 0,
				durationMs: 12,
			});
	});
});
