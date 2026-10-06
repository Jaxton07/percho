import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

/** getLoadedResources 的诊断分级：未接的官方内置扩展降级为 info（不弹红），其余仍是 error。 */
function makeBackend(errors: { path: string; error: string }[]): PiBackend {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({
		session: {
			sessionId: "s1",
			resourceLoader: {
				getSkills: () => ({ skills: [], diagnostics: [] }),
				getExtensions: () => ({ extensions: [], errors }),
			},
		} as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: "/tmp",
	});
	return backend;
}

describe("getLoadedResources 诊断分级", () => {
	it("未知 builtin 降级为 info，其它错误保持 error", async () => {
		const backend = makeBackend([
			{ path: "builtin:llama.cpp", error: "Unknown built-in extension: builtin:llama.cpp" },
			{ path: "/tmp/broken-ext.ts", error: "Failed to load extension" },
		]);

		const resources = await backend.getLoadedResources("s1");

		expect(resources.extensionErrors).toEqual([
			{ path: "builtin:llama.cpp", error: "Unknown built-in extension: builtin:llama.cpp", level: "info" },
			{ path: "/tmp/broken-ext.ts", error: "Failed to load extension", level: "error" },
		]);
	});

	it("无诊断时为空数组", async () => {
		const resources = await makeBackend([]).getLoadedResources("s1");
		expect(resources.extensionErrors).toEqual([]);
	});
});
