import { describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { RegisteredSession } from "../src/session/registry";
import { SessionRegistry } from "../src/session/registry";

/**
 * 回归：**会话终结必须先发 `session_shutdown`、再 `session.dispose()`**。
 *
 * 背景（2026-10-08 定位）：SDK 的 `AgentSession.dispose()` 只 `invalidate()` 扩展 runner、
 * **不发 `session_shutdown`**（pi 1.0.4 `core/agent-session.js:988`），而官方内置扩展里
 * **只有 mcp** 用这个事件释放资源 —— 漏发的后果是 MCP stdio 子进程永久常驻：关掉会话
 * 只减少内存里的 runner，`uvx`/`node` 那棵子树照旧活着并占着 MCP server 的连接。
 * 官方自己的 `AgentSessionRuntime.dispose()` 是「先 emit 再 dispose」，Percho 与之对齐。
 */

/** 只记录「事件发出 / dispose 调用」顺序的假会话（不碰真实 SDK） */
function makeEntry(order: string[], sessionId = "s1"): RegisteredSession {
	return {
		session: {
			sessionId,
			extensionRunner: {
				emit: async (event: { type: string; reason?: string }) => {
					order.push(`emit:${event.type}:${event.reason ?? ""}`);
				},
			},
			dispose: () => {
				order.push("dispose");
			},
		},
		unsubscribe: () => {},
		cwd: "/tmp",
		gate: { dispose: () => {} },
		dialogs: { dispose: () => {} },
		modeRef: {},
	} as unknown as RegisteredSession;
}

/** 绕过 private 取内部方法（只为验证调用契约，不碰真实会话） */
type BackendInternals = { disposeSession(entry: RegisteredSession): Promise<void> };

describe("会话终结的 session_shutdown", () => {
	it("disposeSession：先 emit session_shutdown（reason=quit）再 dispose", async () => {
		const order: string[] = [];
		const backend = new PiBackend();

		await (backend as unknown as BackendInternals).disposeSession(makeEntry(order));

		expect(order).toEqual(["emit:session_shutdown:quit", "dispose"]);
		backend.dispose();
	});

	it("disposeSession：emit 失败不阻塞 dispose（清理不能因为扩展抛错而断掉）", async () => {
		const order: string[] = [];
		const entry = makeEntry(order);
		// 让 emit reject
		(entry.session as unknown as { extensionRunner: { emit: () => Promise<void> } }).extensionRunner.emit =
			async () => {
				order.push("emit:threw");
				throw new Error("extension blew up");
			};

		const backend = new PiBackend();
		await expect((backend as unknown as BackendInternals).disposeSession(entry)).resolves.toBeUndefined();

		expect(order).toEqual(["emit:threw", "dispose"]);
		backend.dispose();
	});

	it("disposeAll（before-quit 同步路径）：同样会 emit session_shutdown", async () => {
		const order: string[] = [];
		const registry = new SessionRegistry();
		registry.add(makeEntry(order));

		registry.disposeAll();
		// fire-and-forget：假 emit 的函数体在同步段就跑完，无需等微任务
		await Promise.resolve();

		expect(order).toEqual(["emit:session_shutdown:quit", "dispose"]);
	});
});
