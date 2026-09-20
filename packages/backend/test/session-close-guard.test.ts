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

function makeBackend(sessionId: string, streaming: boolean, sessionFile?: string) {
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
