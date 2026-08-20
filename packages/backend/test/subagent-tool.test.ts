import { describe, expect, it } from "vitest";
import type { SingleResult } from "../src/tools/subagent/runner";
import { finalizeSubagentResult } from "../src/tools/subagent/tool";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "scout",
		task: "t",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: { tokens: 0 } },
		artifactPaths: {},
		...overrides,
	};
}

describe("finalizeSubagentResult（失败语义 spec §6）", () => {
	it("single 成功：content 为结论，无 isError", () => {
		const result = finalizeSubagentResult("single", [makeResult({ content: "done" })]);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]).toEqual({ type: "text", text: "done" });
	});

	it("single 失败：isError + content 带诊断（不给模型空字符串）", () => {
		const result = finalizeSubagentResult("single", [
			makeResult({ exitCode: 1, error: "model exploded", content: undefined }),
		]);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Subagent scout failed: model exploded",
		});
	});

	it("single 无错误消息的失败（abort）：回落 aborted 诊断", () => {
		const result = finalizeSubagentResult("single", [makeResult({ exitCode: 1 })]);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "Subagent scout failed: aborted" });
	});

	it("parallel 部分失败：不置 isError，Error 行在 content 里", () => {
		const result = finalizeSubagentResult("parallel", [
			makeResult({ content: "ok" }),
			makeResult({ agent: "scout2", exitCode: 1, error: "boom" }),
		]);
		expect(result.isError).toBeUndefined();
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("## 1. scout\nok");
		expect(text).toContain("## 2. scout2\nError: boom");
	});

	it("parallel 全败：isError", () => {
		const result = finalizeSubagentResult("parallel", [
			makeResult({ exitCode: 1, error: "a" }),
			makeResult({ exitCode: 1, error: "b" }),
		]);
		expect(result.isError).toBe(true);
	});
});
