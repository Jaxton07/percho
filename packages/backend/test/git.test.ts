import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutBranch, getGitBranch, listGitBranches } from "../src/git";

const exec = promisify(execFile);
let root: string, repo: string, other: string;
const git = async (cwd: string, ...args: string[]) =>
	(await exec("git", args, { cwd, env: process.env })).stdout.trim();
async function initialize(path: string) {
	await mkdir(path);
	await git(path, "init", "-q", "-b", "main", `--template=${root}/template`);
	await git(path, "config", "user.name", "Isolated fixture");
	await git(path, "config", "user.email", "fixture@example.invalid");
	await writeFile(`${path}/file.txt`, "MAIN");
	await git(path, "add", "file.txt");
	await git(path, "commit", "-qm", "Initial fixture");
	await git(path, "checkout", "-qb", "feature/team");
	await writeFile(`${path}/file.txt`, "FEATURE");
	await git(path, "commit", "-qam", "Feature fixture");
	await git(path, "checkout", "-q", "main");
	expect(await git(path, "rev-parse", "--show-toplevel")).toBe(path);
}
beforeEach(async () => {
	const parent = resolve("../../.local/tmp/ssh-remote-runtime/git-tests");
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(`${parent}/case-`);
	await mkdir(`${root}/template`);
	for (const name of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_NAMESPACE",
		"GIT_TEMPLATE_DIR",
		"GIT_CONFIG_PARAMETERS",
		"GIT_CONFIG_COUNT",
	])
		vi.stubEnv(name, undefined);
	await writeFile(`${root}/empty-config`, "");
	vi.stubEnv("GIT_CONFIG_GLOBAL", `${root}/empty-config`);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	repo = `${root}/repo`;
	other = `${root}/other`;
	await initialize(repo);
	await initialize(other);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});
describe("Git bound to its repository", () => {
	it("lists and switches only exact local refs; inherited repository variables cannot redirect the action", async () => {
		vi.stubEnv("GIT_DIR", `${other}/.git`);
		vi.stubEnv("GIT_WORK_TREE", other);
		vi.stubEnv("GIT_INDEX_FILE", `${other}/.git/index`);
		expect((await listGitBranches(repo)).branches).toEqual(["feature/team", "main"]);
		expect(await checkoutBranch(repo, "feature/team")).toBe("feature/team");
		expect(await getGitBranch(other)).toBe("main");
		expect(await readFile(`${other}/file.txt`, "utf8")).toBe("MAIN");
		for (const branch of ["--detach", "-B", "HEAD", "@{-1}", "does-not-exist"])
			await expect(checkoutBranch(repo, branch)).rejects.toThrow();
		expect(await getGitBranch(repo)).toBe("feature/team");
	});
	it("preserves dirty work and existing Git locks on actual checkout failures", async () => {
		await writeFile(`${repo}/file.txt`, "DIRTY");
		await expect(checkoutBranch(repo, "feature/team")).rejects.toThrow();
		expect(await readFile(`${repo}/file.txt`, "utf8")).toBe("DIRTY");
		expect(await getGitBranch(repo)).toBe("main");
		await writeFile(`${repo}/file.txt`, "MAIN");
		await writeFile(`${repo}/.git/index.lock`, "fixture lock");
		await expect(checkoutBranch(repo, "feature/team")).rejects.toThrow(/index.lock/);
		expect(await readFile(`${repo}/.git/index.lock`, "utf8")).toBe("fixture lock");
		expect(await getGitBranch(repo)).toBe("main");
	});
	it("distinguishes non-repositories, unborn branches and genuine Git failures", async () => {
		// An explicit ceiling prevents this test directory from inheriting the source repository above it.
		vi.stubEnv("GIT_CEILING_DIRECTORIES", root);
		await mkdir(`${root}/plain`);
		expect(await listGitBranches(`${root}/plain`)).toEqual({ current: null, branches: [] });
		await mkdir(`${root}/empty`);
		await git(`${root}/empty`, "init", "-q", "-b", "main");
		expect(await getGitBranch(`${root}/empty`)).toBe("main");
		await expect(getGitBranch(`${root}/missing`)).rejects.toThrow();
	});
});
