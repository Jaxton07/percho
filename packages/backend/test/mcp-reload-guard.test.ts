import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRegistry } from "../src/session/registry";

/**
 * mcp.json 变更后的 reload 守卫（REVIEW §3）：运行中（streaming/compacting）的会话必须**跳过**。
 * `AgentSession.reload()` 没有运行中守卫、不 abort 在跑的 turn，却会 `emitSessionShutdown`
 * → 官方 mcp 扩展收到就关掉全部连接、旧 runner 被废弃：在别的会话跑长任务时改配置会静默打断它。
 *
 * ❗**必须隔离 agentDir**：`upsertMcpServer` 会真的写「全局 `<agentDir>/mcp.json`」。不 mock
 * `getAgentDir` 就写开发者真实的 `~/.pi/agent/mcp.json` —— 而且断言一旦失败，用例后半段的
 * remove 不会执行，测试用的 `demo` 就**永久残留在真实配置里**（2026-10-08 实测踩到：本地
 * 配了 blender server → 全局列表断言失败 → 残留）。隔离写法与 `mcp-config.test.ts` 一致。
 */
const agentDir = vi.hoisted(() => ({ value: "" }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, getAgentDir: () => agentDir.value };
});

const { PiBackend } = await import("../src/pi-backend");

let root = "";
let project = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "percho-mcp-reload-guard-"));
	project = join(root, "project");
	mkdirSync(project, { recursive: true });
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});
function stubSession(options: { sessionId: string; isStreaming?: boolean; isCompacting?: boolean }) {
	const reload = vi.fn().mockResolvedValue(undefined);
	const session = {
		sessionId: options.sessionId,
		get isStreaming() {
			return options.isStreaming ?? false;
		},
		get isCompacting() {
			return options.isCompacting ?? false;
		},
		reload,
		getAllTools: () => [],
	} as unknown as AgentSession;
	return { session, reload };
}

function makeBackend(entries: { session: AgentSession; cwd?: string }[]) {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	for (const entry of entries) {
		registry.add({ session: entry.session, unsubscribe: () => {}, cwd: entry.cwd ?? project });
	}
	return backend;
}

describe("MCP reload 守卫", () => {
	it("project mutations reload only their cwd; failures continue and global reconnect spans all cwd", async () => {
		const otherCwd = join(root, "other-project");
		mkdirSync(otherCwd, { recursive: true });
		const failed = stubSession({ sessionId: "failed" });
		failed.reload.mockRejectedValue(new Error("reload failure"));
		const later = stubSession({ sessionId: "later" });
		const other = stubSession({ sessionId: "other" });
		const busy = stubSession({ sessionId: "busy", isStreaming: true });
		// Persist a real trusted-project fixture in the isolated agent dir; no trust bypass.
		new ProjectTrustStore(agentDir.value).set(project, true);
		const backend = makeBackend([
			{ session: failed.session },
			{ session: later.session },
			{ session: other.session, cwd: otherCwd },
			{ session: busy.session },
		]);

		const changed = await backend.upsertMcpServer({
			scope: "project",
			name: "demo",
			cwd: project,
			command: "node",
		});
		expect(changed.reload).toEqual({ reloaded: 1, skipped: [{ sessionId: "busy", reason: "streaming" }] });
		expect(other.reload).not.toHaveBeenCalled();
		const removed = await backend.removeMcpServer({ scope: "project", name: "demo", cwd: project });
		expect(removed.reload).toEqual(changed.reload);
		expect(other.reload).not.toHaveBeenCalled();
		const global = await backend.reloadMcpServers({ cwd: project });
		expect(global.reload).toEqual({ reloaded: 2, skipped: [{ sessionId: "busy", reason: "streaming" }] });
		expect(failed.reload).toHaveBeenCalledTimes(3);
		expect(later.reload).toHaveBeenCalledTimes(3);
		expect(other.reload).toHaveBeenCalledTimes(1);
		expect(busy.reload).not.toHaveBeenCalled();
	});
	it.each(["streaming", "compacting"] as const)(
		"reads next session %s state after awaiting the preceding reload",
		async (reason) => {
			let release: (() => void) | undefined;
			const first = stubSession({ sessionId: "first" });
			first.reload.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			);
			const nextState = { sessionId: "next", isStreaming: false, isCompacting: false };
			const next = stubSession(nextState);
			const backend = makeBackend([{ session: first.session }, { session: next.session }]);
			const loading = backend.reloadMcpServers({ cwd: project });
			try {
				await vi.waitFor(() => expect(first.reload).toHaveBeenCalledTimes(1));
				if (reason === "streaming") nextState.isStreaming = true;
				else nextState.isCompacting = true;
			} finally {
				release?.();
			}
			const result = await loading;
			expect(result.reload).toEqual({ reloaded: 1, skipped: [{ sessionId: "next", reason }] });
			expect(next.reload).not.toHaveBeenCalled();
		},
	);
	it("运行中的会话被跳过并回报原因，空闲会话照常 reload", async () => {
		const streaming = stubSession({ sessionId: "running", isStreaming: true });
		const compacting = stubSession({ sessionId: "compacting", isCompacting: true });
		const idle = stubSession({ sessionId: "idle" });
		const backend = makeBackend([
			{ session: streaming.session },
			{ session: compacting.session },
			{ session: idle.session },
		]);

		const result = await backend.reloadMcpServers({ cwd: project });

		expect(result.reload.reloaded).toBe(1);
		expect(result.reload.skipped).toEqual([
			{ sessionId: "running", reason: "streaming" },
			{ sessionId: "compacting", reason: "compacting" },
		]);
		expect(streaming.reload).not.toHaveBeenCalled();
		expect(compacting.reload).not.toHaveBeenCalled();
		expect(idle.reload).toHaveBeenCalledTimes(1);
	});

	it("upsert/remove 也走同一把守卫（写入成功 + 运行中的不重连）", async () => {
		const running = stubSession({ sessionId: "running", isStreaming: true });
		const backend = makeBackend([{ session: running.session }]);

		const upserted = await backend.upsertMcpServer({
			scope: "user",
			name: "demo",
			command: "node",
			cwd: project,
		});
		expect(upserted.config.global.map((s) => s.name)).toEqual(["demo"]);
		expect(upserted.reload).toEqual({
			reloaded: 0,
			skipped: [{ sessionId: "running", reason: "streaming" }],
		});

		const removed = await backend.removeMcpServer({ scope: "user", name: "demo", cwd: project });
		expect(removed.config.global).toEqual([]);
		expect(removed.reload.skipped).toHaveLength(1);
		expect(running.reload).not.toHaveBeenCalled();
	});
});
