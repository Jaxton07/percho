import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

/**
 * mcp.json 变更后的 reload 守卫（REVIEW §3）：运行中（streaming/compacting）的会话必须**跳过**。
 * `AgentSession.reload()` 没有运行中守卫、不 abort 在跑的 turn，却会 `emitSessionShutdown`
 * → 官方 mcp 扩展收到就关掉全部连接、旧 runner 被废弃：在别的会话跑长任务时改配置会静默打断它。
 */
function stubSession(options: { sessionId: string; isStreaming?: boolean; isCompacting?: boolean }) {
	const reload = vi.fn().mockResolvedValue(undefined);
	const session = {
		sessionId: options.sessionId,
		isStreaming: options.isStreaming ?? false,
		isCompacting: options.isCompacting ?? false,
		reload,
		getAllTools: () => [],
	} as unknown as AgentSession;
	return { session, reload };
}

function makeBackend(entries: { session: AgentSession; cwd?: string }[]) {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	for (const entry of entries) {
		registry.add({ session: entry.session, unsubscribe: () => {}, cwd: entry.cwd ?? "/tmp/project" });
	}
	return backend;
}

describe("MCP reload 守卫", () => {
	it("运行中的会话被跳过并回报原因，空闲会话照常 reload", async () => {
		const streaming = stubSession({ sessionId: "running", isStreaming: true });
		const compacting = stubSession({ sessionId: "compacting", isCompacting: true });
		const idle = stubSession({ sessionId: "idle" });
		const backend = makeBackend([
			{ session: streaming.session },
			{ session: compacting.session },
			{ session: idle.session },
		]);

		const result = await backend.reloadMcpServers({ cwd: "/tmp/project" });

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
			cwd: "/tmp/project",
		});
		expect(upserted.config.global.map((s) => s.name)).toEqual(["demo"]);
		expect(upserted.reload).toEqual({
			reloaded: 0,
			skipped: [{ sessionId: "running", reason: "streaming" }],
		});

		const removed = await backend.removeMcpServer({ scope: "user", name: "demo", cwd: "/tmp/project" });
		expect(removed.config.global).toEqual([]);
		expect(removed.reload.skipped).toHaveLength(1);
		expect(running.reload).not.toHaveBeenCalled();
	});
});
