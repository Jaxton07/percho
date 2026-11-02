import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
