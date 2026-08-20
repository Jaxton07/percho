import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applySubagentMutex } from "../src/tools/subagent/mutex";

function extensionsResult(tools: string[]): LoadExtensionsResult {
	return {
		extensions: [
			{
				path: "/tmp/pi-subagents.ts",
				resolvedPath: "/tmp/pi-subagents.ts",
				sourceInfo: { source: "pi-subagents", scope: "user", origin: "top-level" },
				hidden: false,
				handlers: new Map(),
				tools: new Map(tools.map((name) => [name, {} as never])),
				messageRenderers: new Map(),
				commands: new Map(),
				flags: new Map(),
				shortcuts: new Map(),
			},
		],
		errors: [],
		runtime: {} as LoadExtensionsResult["runtime"],
	};
}

describe("subagent mutex", () => {
	it("keeps builtin subagent and disables sibling third-party tools", () => {
		const active = ["read", "subagent", "subagent_wait", "subagent_status"];
		const session = {
			getActiveToolNames: () => active,
			setActiveToolsByName: (names: string[]) => active.splice(0, active.length, ...names),
		};
		const result = applySubagentMutex(
			session,
			extensionsResult(["subagent", "subagent_wait", "subagent_status"]),
			true,
		);
		expect(result.shadowed).toEqual([
			{ extensionPath: "/tmp/pi-subagents.ts", tools: ["subagent", "subagent_wait", "subagent_status"] },
		]);
		expect(result.disabledToolNames).toEqual(["subagent_wait", "subagent_status"]);
		expect(active).toEqual(["read", "subagent"]);
	});

	it("does nothing when builtin preference is disabled", () => {
		const session = { getActiveToolNames: () => ["subagent_wait"], setActiveToolsByName: () => undefined };
		expect(applySubagentMutex(session, extensionsResult(["subagent_wait"]), false)).toEqual({
			shadowed: [],
			disabledToolNames: [],
		});
	});
});
