import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ error: undefined as Error | undefined, stdout: "" }));
vi.mock("node:child_process", () => ({
	execFile: vi.fn((_command, _args, _options, callback) => callback(probe.error, { stdout: probe.stdout })),
}));

import { resolveChannelProject } from "../src/tools/channels/project";

const boundary =
	"fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n";
let fixture: string;
beforeEach(async () => {
	const prefix = fileURLToPath(new URL("../../../.local/tmp/channels-project-", import.meta.url));
	await mkdir(dirname(prefix), { recursive: true });
	fixture = await mkdtemp(prefix);
	await mkdir(join(fixture, "project", "child"), { recursive: true });
	await mkdir(join(fixture, "other"));
	probe.error = undefined;
	probe.stdout = fixture;
});
afterEach(async () => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	await rm(fixture, { recursive: true, force: true });
});
function gitFailure(stderr: string, code: number | string = 128) {
	return Object.assign(new Error("Git probe failed"), { code, stderr });
}

it.each([
	"fatal: not a git repository\n",
	"fatal: not a git repository (or any of the parent directories): .git\n",
	boundary,
	boundary.replaceAll("\n", "\r\n"),
])("resolves a standalone project for explicit non-repository output: %s", async (stderr) => {
	probe.error = gitFailure(stderr);
	const cwd = join(fixture, "project", "child");
	expect(await resolveChannelProject(cwd)).toBe(await realpath(cwd));
});

it("preserves explicit non-Git project binding at a filesystem boundary", async () => {
	probe.error = gitFailure(boundary);
	const root = join(fixture, "project");
	expect(await resolveChannelProject(join(root, "child"), root)).toBe(await realpath(root));
	await expect(resolveChannelProject(join(fixture, "other"), root)).rejects.toThrow("does not contain cwd");
});

it.each([
	[128, "fatal: detected dubious ownership in repository at '/other'\n"],
	[128, `${boundary}fatal: unexpected error\n`],
	[1, boundary],
	["ENOENT", boundary],
])("does not hide unrelated Git failures (%s)", async (code, stderr) => {
	probe.error = gitFailure(String(stderr), code);
	await expect(resolveChannelProject(fixture)).rejects.toBe(probe.error);
});

it("uses the Git root while removing inherited repository overrides", async () => {
	vi.stubEnv("GIT_DIR", "/other");
	vi.stubEnv("GIT_DISCOVERY_ACROSS_FILESYSTEM", "1");
	expect(await resolveChannelProject(join(fixture, "project"))).toBe(await realpath(fixture));
	const options = vi.mocked(execFile).mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
	expect(Object.keys(options.env).filter((key) => key.toUpperCase().startsWith("GIT_"))).toEqual([]);
	expect(options.env.LC_ALL).toBe("C");
});
