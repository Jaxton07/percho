import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

/**
 * `closeSession` 的 isStreaming 守卫（内存策略的最后一道门）与删除路径的绕行。
 * 用 stub session 注入私有 registry（同 prompt-ack.test.ts 手法）：不触网、不依赖 SDK/凭证。
 */
// OS 临时目录（同 test/permission-extension.test.ts 的约定）：**不要**用 `process.cwd()/.local/tmp`
// —— workspace 脚本的 cwd 是 packages/backend，仓根跑与包内跑不一致会让整个文件加载失败（= 测试静默不跑）
const root = mkdtempSync(join(tmpdir(), "pi-close-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeBackend(sessionId: string, streaming: boolean, sessionFile?: string, topics: string[] = []) {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	const dispose = vi.fn();
	registry.add({
		session: {
			sessionId,
			isStreaming: streaming,
			dispose,
			sessionFile,
			sessionManager: { getSessionDir: () => root, getSessionFile: () => sessionFile },
		} as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: root,
		gate: { dispose: () => {} },
		dialogs: { dispose: () => {} },
		modeRef: { get: () => "default" },
	} as never);
	// 频道订阅快照（生产路径：channel-watch 扩展经 session_start/subscribe/unsubscribe 回调上报）
	backend.reportChannelSubscriptions(sessionId, new Set(topics));
	return { backend, registry, dispose };
}

describe("PiBackend.closeSession 守卫", () => {
	it("agent 在跑（isStreaming，含等审批）→ 拒绝：closed=false、不 dispose、会话仍在 registry", async () => {
		const { backend, registry, dispose } = makeBackend("s1", true);
		await expect(backend.closeSession("s1")).resolves.toEqual({ closed: false });
		expect(dispose).not.toHaveBeenCalled();
		expect(registry.has("s1")).toBe(true);
	});

	it("空闲 → 正常关：closed=true、dispose 生效、会话出 registry", async () => {
		const { backend, registry, dispose } = makeBackend("s2", false);
		await expect(backend.closeSession("s2")).resolves.toEqual({ closed: true });
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(registry.has("s2")).toBe(false);
	});

	it("会话根本不在 registry（已关/从未打开）→ closed=true（幂等：它确实没在跑）", async () => {
		const { backend } = makeBackend("s3", false);
		await expect(backend.closeSession("不存在的会话")).resolves.toEqual({ closed: true });
	});
});

describe("PiBackend.deleteSession 绕开守卫", () => {
	it("isStreaming 时显式删除照样生效（dispose + 文件 unlink），行为与改动前一致", async () => {
		const dir = join(root, "proj");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "s4.jsonl");
		writeFileSync(file, "");
		const { backend, registry, dispose } = makeBackend("s4", true, file);

		await backend.deleteSession("s4", file);

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(registry.has("s4")).toBe(false);
		expect(() => writeFileSync(file, "x")).not.toThrow(); // 目录仍在（只删了文件）
		await expect(backend.closeSession("s4")).resolves.toEqual({ closed: true }); // 删完再关 = 幂等
	});
});

// ---------------------------------------------------------------------------
// P0（spec channel-watch-retention-catchup §6.2）：GC 意图守卫 + 订阅快照查询
// 以下用例为阶段 0 红测：固定契约，实现见 plan 阶段 1.1～1.2。
// ---------------------------------------------------------------------------

describe("PiBackend · GC 意图（intent）与频道订阅守卫", () => {
	it("intent:'gc' + 会话有有效订阅 → 拒绝：closed=false、不 dispose、会话仍在 registry", async () => {
		const { backend, registry, dispose } = makeBackend("g1", false, undefined, ["t1"]);
		await expect(backend.closeSession("g1", "gc")).resolves.toEqual({ closed: false });
		expect(dispose).not.toHaveBeenCalled();
		expect(registry.has("g1")).toBe(true);
	});

	it("intent:'user' / 缺省 + 有订阅 → 正常关（用户明确意图不被订阅挡）", async () => {
		const asUser = makeBackend("g2", false, undefined, ["t1"]);
		await expect(asUser.backend.closeSession("g2", "user")).resolves.toEqual({ closed: true });
		expect(asUser.dispose).toHaveBeenCalledTimes(1);

		const asDefault = makeBackend("g3", false, undefined, ["t1"]);
		await expect(asDefault.backend.closeSession("g3")).resolves.toEqual({ closed: true });
		expect(asDefault.dispose).toHaveBeenCalledTimes(1);
	});

	it("intent:'gc' + 已退订（无订阅）→ 正常关（退订最后一个 topic 即恢复 GC 资格）", async () => {
		const { backend, registry, dispose } = makeBackend("g4", false);
		await expect(backend.closeSession("g4", "gc")).resolves.toEqual({ closed: true });
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(registry.has("g4")).toBe(false);
	});

	it("intent:'gc' + 有订阅 + agent 在跑 → 照样拒绝（streaming 门不受影响）", async () => {
		const { backend, dispose } = makeBackend("g5", true, undefined, ["t1"]);
		await expect(backend.closeSession("g5", "gc")).resolves.toEqual({ closed: false });
		expect(dispose).not.toHaveBeenCalled();
	});

	it("有订阅的会话显式 delete 仍生效（明确用户意图优先于订阅保护）", async () => {
		const dir = join(root, "proj-sub");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "g6.jsonl");
		writeFileSync(file, "");
		const { backend, registry, dispose } = makeBackend("g6", true, file, ["t1"]);

		await backend.deleteSession("g6", file);

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(registry.has("g6")).toBe(false);
	});
});

describe("PiBackend · 频道订阅快照查询", () => {
	it("上报非空进快照、空集移出（disabled/untrusted 上报空集即解除保护）", () => {
		const { backend } = makeBackend("s1", false, undefined, ["t1", "t2"]);
		makeBackend("s2", false, undefined, []);
		expect(backend.getChannelSubscriptionSessionIds()).toEqual(["s1"]);

		backend.reportChannelSubscriptions("s1", new Set(["t1"]));
		expect(backend.getChannelSubscriptionSessionIds()).toEqual(["s1"]);
		backend.reportChannelSubscriptions("s1", new Set());
		expect(backend.getChannelSubscriptionSessionIds()).toEqual([]);
	});

	it("查询只返回仍在 registry 的会话：孤儿键（回调/构造失败残留）不得影响 GC", () => {
		const { backend } = makeBackend("alive", false, undefined, ["t1"]);
		backend.reportChannelSubscriptions("ghost", new Set(["t1"]));
		expect(backend.getChannelSubscriptionSessionIds()).toEqual(["alive"]);
	});

	it("dispose 后无残留（扩展 shutdown 回调之外的双保险）", async () => {
		const { backend } = makeBackend("s3", false, undefined, ["t1"]);
		await backend.closeSession("s3", "user");
		expect(backend.getChannelSubscriptionSessionIds()).toEqual([]);
	});
});
