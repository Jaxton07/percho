import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionRegistry } from "../src/session/registry";

const agentDir = vi.hoisted(() => ({ value: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => agentDir.value,
}));
const { PiBackend } = await import("../src/pi-backend");
let root = "";
beforeEach(() => {
	const base = resolve("../../.local/tmp/reconnect-native");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "save-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("saves all mutations without touching idle or busy sessions and retains a process-wide restart flag", async () => {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	const sessions = [false, true].map((isStreaming, index) => ({
		sessionId: `session-${index}`,
		isStreaming,
		isCompacting: false,
		reload: vi.fn(),
		abort: vi.fn(),
		getAllTools: () => [],
	}));
	for (const session of sessions)
		registry.add({ session: session as unknown as AgentSession, unsubscribe: () => {}, cwd: root });
	expect((await backend.getMcpConfig()).restartRequired).toBeFalsy();
	await expect(backend.upsertMcpServer({ scope: "project", name: "bad", command: "node" })).rejects.toThrow();
	expect((await backend.getMcpConfig()).restartRequired).toBeFalsy();
	for (const result of [
		await backend.upsertMcpServer({ scope: "user", name: "demo", command: "node" }),
		await backend.upsertMcpServer({ scope: "user", name: "demo", command: "node", args: ["x"] }),
		await backend.importMcpServers({ json: JSON.stringify({ mcpServers: { other: { command: "node" } } }) }),
		await backend.removeMcpServer({ scope: "user", name: "demo" }),
	])
		expect(result.config.restartRequired).toBe(true);
	expect((await backend.getMcpConfig({ cwd: root })).restartRequired).toBe(true);
	for (const session of sessions) {
		expect(session.reload).not.toHaveBeenCalled();
		expect(session.abort).not.toHaveBeenCalled();
	}
});
