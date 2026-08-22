import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry, type RegisteredSession } from "../src/session/registry";

/** mock AgentSession（RegisteredSession 只用到这些成员；dispose/unsubscribe 用 spy 断言） */
function makeEntry(sessionId: string, sessionFile: string): {
	entry: RegisteredSession;
	dispose: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
} {
	const dispose = vi.fn();
	const unsubscribe = vi.fn();
	const session = {
		sessionId,
		sessionFile,
		sessionName: undefined,
		model: null,
		thinkingLevel: "medium",
		messages: [],
		dispose,
	};
	return { entry: { session, unsubscribe, cwd: "/tmp" } as unknown as RegisteredSession, dispose, unsubscribe };
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "registry-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("SessionRegistry disposeAll（B8：与 closeSession 对称）", () => {
	it("逐会话 unsubscribe + session.dispose 并清空", () => {
		const registry = new SessionRegistry();
		const a = makeEntry("a", join(dir, "a.jsonl"));
		const b = makeEntry("b", join(dir, "b.jsonl"));
		registry.add(a.entry);
		registry.add(b.entry);

		registry.disposeAll();

		expect(a.dispose).toHaveBeenCalledOnce();
		expect(a.unsubscribe).toHaveBeenCalledOnce();
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

		registry.disposeAll();

		expect(a.dispose).not.toHaveBeenCalled();
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
