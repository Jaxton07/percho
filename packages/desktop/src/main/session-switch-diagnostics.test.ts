import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userData: "",
	begin: vi.fn(),
	finish: vi.fn(() => ({ stages: [], payloadBytes: 0 })),
}));
vi.mock("electron", () => ({ app: { getPath: () => mocks.userData } }));
vi.mock("@percho/backend", () => ({
	beginSessionSwitchProbe: mocks.begin,
	finishSessionSwitchProbe: mocks.finish,
}));

import {
	beginIsolatedSessionSwitchProbe,
	finishIsolatedSessionSwitchProbe,
	getSessionSwitchFixtures,
} from "./session-switch-diagnostics";

let directory: string;
let root: string;
beforeEach(async () => {
	const base = resolve("../../.local/tmp/session-switch-guard-tests");
	await mkdir(base, { recursive: true });
	directory = await mkdtemp(join(base, "run-"));
	root = join(directory, ".local/tmp/session-switch-diagnostics");
	await mkdir(join(root, "agent/sessions"), { recursive: true });
	await mkdir(join(root, "user-data-dev"), { recursive: true });
	mocks.userData = join(root, "user-data-dev");
	vi.stubEnv("PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT", root);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	vi.clearAllMocks();
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

describe("合成诊断隔离门", () => {
	it("允许仓库内独立运行的夹具并拒绝不匹配的 agent", async () => {
		const base = fileURLToPath(new URL("../../../../.local/test/performance", import.meta.url));
		await mkdir(base, { recursive: true });
		const run = await mkdtemp(join(base, "guard-test-"));
		try {
			const isolated = join(run, "work/switch");
			await mkdir(join(isolated, "agent/sessions"), { recursive: true });
			await mkdir(join(isolated, "user-data-dev"));
			const fixtures = [];
			for (const name of ["screenshots", "text", "long-text", "large-turn", "branches"]) {
				const file = join(isolated, "agent/sessions", `${name}.jsonl`);
				await writeFile(file, "synthetic");
				fixtures.push({ name, file, bytes: 9 });
			}
			await writeFile(join(isolated, "manifest.json"), JSON.stringify(fixtures));
			const owner = "b8e8c9d5-7a82-4fd9-b735-d969dfc1df54";
			const marker = join(run, "owner.json");
			vi.stubEnv("PERCHO_PERF_SOURCE", resolve(base, "../../.."));
			vi.stubEnv("PERCHO_PERF_RUN_DIR", run);
			vi.stubEnv("PERCHO_PERF_OWNER", owner);
			vi.stubEnv("PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT", isolated);
			vi.stubEnv("PI_CODING_AGENT_DIR", join(isolated, "agent"));
			mocks.userData = join(isolated, "user-data-dev");
			await expect(getSessionSwitchFixtures()).rejects.toThrow();
			await writeFile(marker, JSON.stringify({ version: 1, kind: "percho-performance-run", owner }));
			vi.stubEnv("PERCHO_PERF_OWNER", "");
			await expect(getSessionSwitchFixtures()).rejects.toThrow("owner mismatch");
			vi.stubEnv("PERCHO_PERF_OWNER", "another-run");
			await expect(getSessionSwitchFixtures()).rejects.toThrow("owner mismatch");
			vi.stubEnv("PERCHO_PERF_OWNER", owner);
			if (process.platform !== "win32") {
				const target = join(run, "other-marker.json");
				await writeFile(target, JSON.stringify({ version: 1, kind: "percho-performance-run", owner }));
				await rm(marker);
				await symlink(target, marker);
				await expect(getSessionSwitchFixtures()).rejects.toThrow("owner marker");
				await rm(marker);
				await writeFile(marker, JSON.stringify({ version: 1, kind: "percho-performance-run", owner }));
			}
			expect(await getSessionSwitchFixtures()).toEqual(fixtures);
			await beginIsolatedSessionSwitchProbe();
			expect(await finishIsolatedSessionSwitchProbe()).toEqual({ stages: [], payloadBytes: 0 });
			vi.stubEnv("PERCHO_PERF_RUN_DIR", join(base, "another-run"));
			await expect(getSessionSwitchFixtures()).rejects.toThrow();
			vi.stubEnv("PERCHO_PERF_RUN_DIR", run);
			vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
			await expect(getSessionSwitchFixtures()).rejects.toThrow("isolation mismatch");
			if (process.platform !== "win32") {
				const link = join(run, "work/link");
				await symlink(isolated, link, "dir");
				vi.stubEnv("PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT", link);
				await expect(getSessionSwitchFixtures()).rejects.toThrow("explicitly isolated");
			}
		} finally {
			await rm(run, { recursive: true, force: true });
		}
	});
	it("拒绝仓库外伪造的 performance 目录", async () => {
		vi.stubEnv(
			"PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT",
			join(directory, ".local/test/performance/run/work/switch"),
		);
		await expect(getSessionSwitchFixtures()).rejects.toThrow("explicitly isolated");
	});
	it("没有显式开关或agent/userData不匹配时拒绝，不触发记录", async () => {
		vi.stubEnv("PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT", "");
		await expect(beginIsolatedSessionSwitchProbe()).rejects.toThrow("explicitly isolated");
		vi.stubEnv("PERCHO_SESSION_SWITCH_DIAGNOSTICS_ROOT", root);
		mocks.userData = directory;
		await expect(beginIsolatedSessionSwitchProbe()).rejects.toThrow("isolation mismatch");
		expect(mocks.begin).not.toHaveBeenCalled();
	});
	it("实际隔离目录和dev后缀可用；不接收用户任意会话路径", async () => {
		const fixtures = [];
		for (const name of ["screenshots", "text", "long-text", "large-turn", "branches"]) {
			const file = join(root, "agent/sessions", `${name}.jsonl`);
			await writeFile(file, "synthetic");
			fixtures.push({ name, file, bytes: 9 });
		}
		await writeFile(join(root, "manifest.json"), JSON.stringify(fixtures));
		expect(await getSessionSwitchFixtures()).toEqual(fixtures);
		await beginIsolatedSessionSwitchProbe();
		expect(mocks.begin).toHaveBeenCalledOnce();
		expect(await finishIsolatedSessionSwitchProbe()).toEqual({ stages: [], payloadBytes: 0 });
		const first = fixtures[0];
		if (!first) throw new Error("Missing fixture");
		first.file = join(directory, "outside.jsonl");
		await writeFile(first.file, "not a fixture");
		await writeFile(join(root, "manifest.json"), JSON.stringify(fixtures));
		await expect(getSessionSwitchFixtures()).rejects.toThrow("fixture path");
	});
	it.skipIf(process.platform === "win32")("拒绝通过符号链接把agent指到隔离目录外", async () => {
		await mkdir(join(directory, "outside"));
		await rm(join(root, "agent"), { recursive: true });
		await symlink(join(directory, "outside"), join(root, "agent"), "dir");
		await expect(beginIsolatedSessionSwitchProbe()).rejects.toThrow("isolation mismatch");
	});
});
