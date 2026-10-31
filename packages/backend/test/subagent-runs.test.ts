import { extractSubagentRuns } from "@percho/shared";
import { describe, expect, it } from "vitest";

describe("子代理结果结构兼容", () => {
	it("新状态优先；旧记录与后台 completions 按原结构派生", () => {
		const summary = { changedFiles: [], commands: [], failedCommands: 0, durationMs: 10 };
		expect(
			extractSubagentRuns({
				results: [
					{ agent: "worker", exitCode: 1, status: "done", summary },
					{ agent: "a", status: "aborted" },
					{ agent: "b", status: "queued" },
				],
			}),
		).toMatchObject([{ status: "done", summary }, { status: "aborted" }, { status: "queued" }]);
		const legacy = extractSubagentRuns({
			results: [
				{ agent: "ok", exitCode: 0 },
				{ agent: "bad", error: "boom" },
				{ agent: "bad2", exitCode: 1 },
			],
		});
		expect(legacy?.map((r) => r.status)).toEqual(["done", "failed", "failed"]);
		expect(legacy?.every((r) => r.summary == null)).toBe(true);
		expect(
			extractSubagentRuns({
				completions: [
					{
						results: [
							{ agent: "background", success: false, artifactPaths: { outputPath: "/session.jsonl" } },
						],
					},
				],
			}),
		).toMatchObject([{ status: "failed", sessionFile: "/session.jsonl" }]);
	});
});
