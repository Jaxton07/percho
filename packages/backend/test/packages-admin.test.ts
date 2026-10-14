import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, getAgentDir } from "@earendil-works/pi-coding-agent";
import { NPM_NOT_FOUND_SENTINEL } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const external = vi.hoisted(() => ({
	install: vi.fn(),
	remove: vi.fn(),
	settings: vi.fn(),
	options: [] as unknown[],
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		SettingsManager: { create: external.settings },
		DefaultPackageManager: class {
			constructor(options: unknown) {
				external.options.push(options);
			}
			installAndPersist(source: string) {
				return external.install(source);
			}
			removeAndPersist(source: string, options: unknown) {
				return external.remove(source, options);
			}
			listConfiguredPackages() {
				return [];
			}
		},
	};
});

import { isNpmSpawnEnoent, PackageAdmin } from "../src/packages/admin";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

beforeEach(() => {
	external.install.mockReset().mockResolvedValue(undefined);
	external.remove.mockReset().mockResolvedValue(true);
	external.settings.mockReset().mockReturnValue({});
	external.options = [];
});

// Only external SDK install/persist is mocked. No npm spawn, downloads or registry replacement.
describe("PackageAdmin public mutations", () => {
	it("install/remove delegate exactly once, preserve void and persistence args, and lazily retain default cwd", async () => {
		const reloadIdleSessions = vi.fn().mockResolvedValue({ reloaded: 2, skipped: [] });
		const cwd = join(tmpdir(), "package-admin-cwd");
		const admin = new PackageAdmin({ reloadIdleSessions, defaultCwd: cwd });
		expect(external.options).toHaveLength(0);
		await expect(admin.installPackage("@scope/demo")).resolves.toBeUndefined();
		expect(external.install).toHaveBeenCalledWith("npm:@scope/demo");
		expect(reloadIdleSessions).toHaveBeenCalledTimes(1);
		expect(external.options).toHaveLength(1);
		expect(external.options[0]).toMatchObject({ cwd, agentDir: getAgentDir() });
		await expect(admin.removePackage("npm:@scope/demo", "project")).resolves.toBeUndefined();
		expect(external.remove).toHaveBeenCalledWith("npm:@scope/demo", { local: true });
		expect(reloadIdleSessions).toHaveBeenCalledTimes(2);
		expect(external.options).toHaveLength(1);
		await admin.removePackage("npm:@scope/demo", "user");
		expect(external.remove).toHaveBeenLastCalledWith("npm:@scope/demo", { local: false });
	});
	it("invalid name, install/remove failure and not-installed never trigger reload", async () => {
		const reloadIdleSessions = vi.fn();
		const admin = new PackageAdmin({ reloadIdleSessions });
		await expect(admin.installPackage("../bad")).rejects.toThrow("Invalid package name");
		expect(external.options).toHaveLength(0);
		const failure = new Error("install failure");
		external.install.mockRejectedValueOnce(failure);
		await expect(admin.installPackage("demo")).rejects.toBe(failure);
		external.remove.mockRejectedValueOnce(failure);
		await expect(admin.removePackage("npm:demo", "user")).rejects.toBe(failure);
		external.remove.mockResolvedValueOnce(false);
		await expect(admin.removePackage("npm:demo", "user")).rejects.toThrow("Package not installed");
		expect(reloadIdleSessions).not.toHaveBeenCalled();
	});
	it.each(["install", "remove"] as const)(
		"%s npm ENOENT keeps its sentinel and does not reload",
		async (kind) => {
			const reloadIdleSessions = vi.fn();
			const admin = new PackageAdmin({ reloadIdleSessions });
			external[kind].mockRejectedValueOnce(new Error("spawn npm ENOENT"));
			const operation =
				kind === "install" ? admin.installPackage("demo") : admin.removePackage("npm:demo", "user");
			await expect(operation).rejects.toThrow(NPM_NOT_FOUND_SENTINEL);
			expect(reloadIdleSessions).not.toHaveBeenCalled();
		},
	);
});

function stubSession(state: { sessionId: string; isStreaming?: boolean; isCompacting?: boolean }) {
	const reload = vi.fn().mockResolvedValue(undefined);
	const session = {
		sessionId: state.sessionId,
		reload,
		get isStreaming() {
			return state.isStreaming ?? false;
		},
		get isCompacting() {
			return state.isCompacting ?? false;
		},
	} as unknown as AgentSession;
	return { session, reload };
}
function backendWithSessions(sessions: AgentSession[]) {
	const backend = new PiBackend();
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	for (const session of sessions)
		registry.add({ session, unsubscribe: () => {}, cwd: join(tmpdir(), "package-cwd") });
	return backend;
}

describe("PackageAdmin real backend reload wiring", () => {
	it.each(["install", "remove"] as const)(
		"%s uses the common streaming/compacting guard and continues after reload failure",
		async (kind) => {
			const streaming = stubSession({ sessionId: "streaming", isStreaming: true });
			const compacting = stubSession({ sessionId: "compacting", isCompacting: true });
			const failed = stubSession({ sessionId: "failed" });
			failed.reload.mockRejectedValue(new Error("reload failure"));
			const later = stubSession({ sessionId: "later" });
			const backend = backendWithSessions([
				streaming.session,
				compacting.session,
				failed.session,
				later.session,
			]);
			const result =
				kind === "install"
					? backend.packages.installPackage("demo")
					: backend.packages.removePackage("npm:demo", "user");
			await expect(result).resolves.toBeUndefined();
			expect(streaming.reload).not.toHaveBeenCalled();
			expect(compacting.reload).not.toHaveBeenCalled();
			expect(failed.reload).toHaveBeenCalledTimes(1);
			expect(later.reload).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["streaming", "compacting"] as const)(
		"next session becoming %s during earlier reload is skipped",
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
			const backend = backendWithSessions([first.session, next.session]);
			const operation = backend.packages.installPackage("demo");
			try {
				await vi.waitFor(() => expect(first.reload).toHaveBeenCalledTimes(1));
				if (reason === "streaming") nextState.isStreaming = true;
				else nextState.isCompacting = true;
			} finally {
				release?.();
			}
			await expect(operation).resolves.toBeUndefined();
			expect(next.reload).not.toHaveBeenCalled();
		},
	);
});

/**
 * npm ENOENT 错误识别（issue #18：GUI 启动 PATH 不含 npm → spawn npm ENOENT）。
 * 命中时抛带 PERCHO_NPM_NOT_FOUND 哨兵的可读错误，renderer 映射为 i18n 文案。
 */

describe("isNpmSpawnEnoent", () => {
	it("裸 spawn npm ENOENT 消息", () => {
		expect(isNpmSpawnEnoent(new Error("spawn npm ENOENT"))).toBe(true);
	});

	it("Electron IPC 包装后的消息（用户实际看到的形态）", () => {
		expect(
			isNpmSpawnEnoent(new Error("Error invoking remote method 'packages:install': Error: spawn npm ENOENT")),
		).toBe(true);
	});

	it("Windows npm.cmd 形态", () => {
		expect(isNpmSpawnEnoent(new Error("spawn npm.cmd ENOENT"))).toBe(true);
	});

	it("带 code/syscall 属性的原始 spawn 错误", () => {
		const err = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT", syscall: "spawn npm" });
		expect(isNpmSpawnEnoent(err)).toBe(true);
	});

	it("其他命令的 ENOENT 不误判", () => {
		expect(isNpmSpawnEnoent(new Error("spawn git ENOENT"))).toBe(false);
		expect(isNpmSpawnEnoent(Object.assign(new Error("x"), { code: "ENOENT", syscall: "spawn git" }))).toBe(
			false,
		);
	});

	it("普通网络/安装错误不误判", () => {
		expect(isNpmSpawnEnoent(new Error("npm ERR! network request failed"))).toBe(false);
		expect(isNpmSpawnEnoent(new Error("ENOENT: no such file or directory, open '/x/package.json'"))).toBe(
			false,
		);
		expect(isNpmSpawnEnoent("some string error")).toBe(false);
	});
});

describe("NPM_NOT_FOUND_SENTINEL", () => {
	it("哨兵值稳定（renderer 依赖此前缀做 i18n 映射）", () => {
		expect(NPM_NOT_FOUND_SENTINEL).toBe("PERCHO_NPM_NOT_FOUND");
	});
});
