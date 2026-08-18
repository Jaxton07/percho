import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

interface SessionState {
	isStreaming: boolean;
	isCompacting: boolean;
}

/** Inject a minimal session so guard behavior stays isolated from the SDK and filesystem. */
function makeBackend(state: SessionState): PiBackend {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({
		session: { sessionId: "s1", ...state } as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: "/tmp",
	});
	return backend;
}

describe("PiBackend session tree operation guards", () => {
	it("rejects fork while context compaction is rewriting the source session", async () => {
		const backend = makeBackend({ isStreaming: false, isCompacting: true });

		await expect(backend.forkSession("s1", { entryId: "target" })).rejects.toThrow(
			"Cannot fork while the agent is running or context is compacting",
		);
	});

	it("rejects recall while context compaction is rewriting the source session", async () => {
		const backend = makeBackend({ isStreaming: false, isCompacting: true });

		await expect(backend.recallMessage("s1", { entryId: "target" })).rejects.toThrow(
			"Cannot recall while the agent is running or context is compacting",
		);
	});
});
