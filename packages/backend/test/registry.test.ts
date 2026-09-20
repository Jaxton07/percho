import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RegisteredSession, SessionRegistry } from "../src/session/registry";

/** mock AgentSession（RegisteredSession 只用到这些成员；dispose/unsubscribe 用 spy 断言） */
function makeEntry(
	sessionId: string,
	sessionFile: string,
): {
	entry: RegisteredSession;
	dispose: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
	gateDispose: ReturnType<typeof vi.fn>;
	dialogsDispose: ReturnType<typeof vi.fn>;
} {
	const dispose = vi.fn();
	const unsubscribe = vi.fn();
	const gateDispose = vi.fn();
	const dialogsDispose = vi.fn();
	const session = {
		sessionId,
		sessionFile,
		sessionName: undefined,
		model: null,
		thinkingLevel: "medium",
		messages: [],
		dispose,
	};
	return {
		entry: {
			session,
			unsubscribe,
			cwd: "/tmp",
			gate: { dispose: gateDispose },
			dialogs: { dispose: dialogsDispose },
			modeRef: { current: "default" },
		} as unknown as RegisteredSession,
		dispose,
		unsubscribe,
		gateDispose,
		dialogsDispose,
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "registry-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("SessionRegistry disposeAll（B8：与 closeSession 对称）", () => {
	it("逐会话 unsubscribe + gate/dialogs/session dispose 并清空", () => {
		const registry = new SessionRegistry();
		const a = makeEntry("a", join(dir, "a.jsonl"));
		const b = makeEntry("b", join(dir, "b.jsonl"));
		registry.add(a.entry);
		registry.add(b.entry);

		registry.disposeAll();

		expect(a.dispose).toHaveBeenCalledOnce();
		expect(a.unsubscribe).toHaveBeenCalledOnce();
		expect(a.gateDispose).toHaveBeenCalledOnce();
		expect(a.dialogsDispose).toHaveBeenCalledOnce();
		expect(b.dispose).toHaveBeenCalledOnce();
		expect(b.unsubscribe).toHaveBeenCalledOnce();
		expect(registry.has("a")).toBe(false);
		expect(registry.has("b")).toBe(false);
		expect(registry.list()).toEqual([]);
	});

	it("delete（closeSession 路径）已移除的会话不会被 disposeAll 双重释放", () => {
		const registry = new SessionRegistry();
		const a = makeEntry("a", join(dir, "a.jsonl"));
		registry.add(a.entry);
		registry.delete("a");

		expect(a.gateDispose).toHaveBeenCalledOnce();
		expect(a.dialogsDispose).toHaveBeenCalledOnce();

		registry.disposeAll();

		expect(a.dispose).not.toHaveBeenCalled();
		expect(a.gateDispose).toHaveBeenCalledOnce();
	});
});

describe("SessionRegistry toMeta createdAt（D7：会话文件 birthtime）", () => {
	it("createdAt 取会话文件 birthtimeMs", () => {
		const file = join(dir, "session.jsonl");
		writeFileSync(file, "{}\n", "utf8");
		const registry = new SessionRegistry();
		const { entry } = makeEntry("s1", file);
		registry.add(entry);

		const meta = registry.toMeta(entry);
		expect(meta.createdAt).toBe(statSync(file).birthtimeMs);
	});

	it("会话文件不存在时回退当前时刻（不抛错）", () => {
		const registry = new SessionRegistry();
		const { entry } = makeEntry("s1", join(dir, "missing.jsonl"));

		const before = Date.now();
		const meta = registry.toMeta(entry);
		expect(meta.createdAt).toBeGreaterThanOrEqual(before);
		expect(meta.createdAt).toBeLessThanOrEqual(Date.now());
	});
});

// ---------------------------------------------------------------------------
// 阶段 0 红测（spec sidebar-session-switch-stability D4）：add 不得静默覆盖同 sessionId 的旧 entry ——
// 覆盖 = 第一份实例的订阅/gate/dialogs 全部泄漏（且没人再能 dispose 它）。
// 防住这条才能让「open 幂等」有意义（构造前短路 + 注册处兜底）。实现见 plan 阶段 3.1。
// ---------------------------------------------------------------------------

describe("SessionRegistry.add 幂等兜底", () => {
	it("同一 sessionId 再 add 不同 entry：抛错，不静默替换旧 entry", () => {
		const registry = new SessionRegistry();
		const first = makeEntry("dup", join(dir, "dup.jsonl"));
		const second = makeEntry("dup", join(dir, "dup.jsonl"));
		registry.add(first.entry);

		expect(() => registry.add(second.entry)).toThrow();

		expect(registry.get("dup")).toBe(first.entry);
		expect(registry.list()).toHaveLength(1);
	});

	it("同 sessionId 重复 add 同一个 entry：幂等（不抛错）", () => {
		const registry = new SessionRegistry();
		const first = makeEntry("dup", join(dir, "dup.jsonl"));
		registry.add(first.entry);

		expect(() => registry.add(first.entry)).not.toThrow();
		expect(registry.list()).toHaveLength(1);
	});
});
