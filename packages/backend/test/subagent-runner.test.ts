import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveSubagentModel, subagentSessionName } from "../src/tools/subagent/runner";

const fallback = { provider: "main", id: "slow" } as Model<any>;
const configured = { provider: "fast", id: "flash" } as Model<any>;
const frontmatter = { provider: "agent", id: "default" } as Model<any>;

function runtime(): ModelRuntime {
	return {
		getModel: (provider: string, id: string) => {
			if (provider === "fast" && id === "flash") return configured;
			if (provider === "agent" && id === "default") return frontmatter;
			return undefined;
		},
		getAvailable: async () => [configured, frontmatter],
	} as unknown as ModelRuntime;
}

describe("subagent runner model and title", () => {
	it("设置页模型优先于 frontmatter，未设置时才回退 frontmatter / 父模型", async () => {
		expect(await resolveSubagentModel(runtime(), "fast/flash", "agent/default", fallback)).toBe(configured);
		expect(await resolveSubagentModel(runtime(), undefined, "agent/default", fallback)).toBe(frontmatter);
		expect(await resolveSubagentModel(runtime(), undefined, undefined, fallback)).toBe(fallback);
	});

	it("子会话标题以 agent 前缀加任务首行，并与主会话一致截断", () => {
		expect(subagentSessionName("scout", "检查 runner\n忽略这行")).toBe("scout: 检查 runner");
		expect(subagentSessionName("scout", "x".repeat(31))).toBe(`scout: ${"x".repeat(30)}…`);
	});
});
