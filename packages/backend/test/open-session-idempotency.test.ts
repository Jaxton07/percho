import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionGate } from "../src/permissions/gate";
import { PiBackend } from "../src/pi-backend";
import { ExtensionDialogHost } from "../src/session/extension-dialog-host";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";

/**
 * 阶段 0 红测（spec D4 / §5 Backend 1-2）：已加载的会话文件再次 open 必须**命中 registry 短路**，
 * 返回现有 entry 的最新 meta，绝不再构造第二个 AgentSession（构造会重复 subscribe/trace，
 * 并在 registry.add 时静默覆盖旧 entry，泄漏第一份实例）。
 *
 * 为什么把 createAgentSession 与资源加载都挡住：真走到构造就会读真实 `~/.pi/agent` 资源、
 * 拉起用户扩展 —— 红测要「不该走到构造」这条路**可判定**（走进去就抛），而不是碰运气。
 * 并发路径的去重契约由 KeyedSingleFlight 单测固定（见 session-single-flight.test.ts）。
 */

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		createAgentSession: () => {
			throw new Error("不该构造第二个 AgentSession（应命中 registry 短路）");
		},
	};
});

const PROJECT = "/tmp/project";

function writeSessionFile(dir: string, id: string): string {
	const file = join(dir, `${id}.jsonl`);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2020-01-01T00:00:00.000Z",
			cwd: PROJECT,
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2021-03-04T05:06:07.000Z",
			message: { role: "user", content: "hi", timestamp: Date.parse("2021-03-04T05:06:07.000Z") },
		}),
	];
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function entryFor(file: string, sessionId: string): RegisteredSession {
	return {
		session: {
			sessionId,
			sessionFile: file,
			sessionName: "已加载会话",
			model: null,
			thinkingLevel: "medium",
			messages: [],
			sessionManager: SessionManager.open(file),
		} as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: PROJECT,
		gate: { dispose: () => {} },
		dialogs: { dispose: () => {} },
		modeRef: { current: "default" },
	} as unknown as RegisteredSession;
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "open-idempotency-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("PiBackend.openSession 幂等（spec D4）", () => {
	it("已在 registry 的会话再 open：返回现有 entry 的 meta，不替换 entry、不重复构造", async () => {
		const file = writeSessionFile(dir, "sess-open");
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		vi.spyOn(
			backend as unknown as { getModelRuntime: () => Promise<ModelRuntime> },
			"getModelRuntime",
		).mockResolvedValue({} as ModelRuntime);
		// 任何构造尝试都要先过资源加载：这里直接抛，命中短路时不会被调用
		const load = vi.fn(() => {
			throw new Error("不该构造第二个 AgentSession（应命中 registry 短路）");
		});
		Object.defineProperty(backend, "projectLoader", { value: { load } });

		const entry = entryFor(file, "sess-open");
		registry.add(entry);

		const meta = await backend.openSession(file);

		expect(meta.sessionId).toBe("sess-open");
		expect(meta).toEqual(registry.toMeta(entry));
		expect(registry.list()).toHaveLength(1);
		expect(registry.get("sess-open")).toBe(entry);
		expect(load).not.toHaveBeenCalled();
	});
});

describe("PiBackend.wireSession 注册冲突（D4 最后防线）", () => {
	it("同 sessionId 已被占住：抛错，并把刚构造的实例拆干净（订阅/gate/dialogs/session）", async () => {
		const file = writeSessionFile(dir, "sess-dup");
		const backend = new PiBackend({
			projectTrust: false,
			permissionGates: false,
			subagentPreferBuiltin: false,
		});
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		// 先占住 sessionId（模拟并发/别名路径：另一个 entry 已经在册）
		const holder = entryFor(file, "sess-dup");
		registry.add(holder);

		const unsubscribe = vi.fn();
		const dispose = vi.fn();
		const gateDispose = vi.spyOn(PermissionGate.prototype, "dispose");
		const dialogsDispose = vi.spyOn(ExtensionDialogHost.prototype, "dispose");
		const session = {
			sessionId: "sess-dup",
			sessionFile: file,
			sessionName: undefined,
			model: null,
			thinkingLevel: "medium",
			messages: [],
			sessionManager: SessionManager.open(file),
			subscribe: () => unsubscribe,
			bindExtensions: () => Promise.resolve(),
			dispose,
		};
		const wire = (
			backend as unknown as {
				wireSession: (cwd: string, readOnly: undefined, make: () => Promise<unknown>) => Promise<unknown>;
			}
		).wireSession.bind(backend);

		await expect(
			wire("/tmp/project", undefined, async () => ({
				session,
				extensionsResult: { extensions: [], errors: [] },
			})),
		).rejects.toThrow(/already registered/);

		try {
			expect(unsubscribe).toHaveBeenCalledTimes(1);
			expect(gateDispose).toHaveBeenCalledTimes(1);
			expect(dialogsDispose).toHaveBeenCalledTimes(1);
			expect(dispose).toHaveBeenCalledTimes(1);
			// 占位 entry 原样保留（没有被静默替换），registry 里也不会多出第二条
			expect(registry.get("sess-dup")).toBe(holder);
			expect(registry.list()).toHaveLength(1);
		} finally {
			gateDispose.mockRestore();
			dialogsDispose.mockRestore();
		}
	});
});
