import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_WORK_REL,
	channelRoot,
	ensureAgentWorkInit,
	planRoot,
	specRoot,
	topicDir,
	validateTopic,
} from "../src/tools/channel-watch/init";

const execFileAsync = promisify(execFile);

let testRoot: string;

beforeAll(async () => {
	testRoot = await mkdtemp(join(tmpdir(), "cw-init-"));
});

afterAll(async () => {
	await rm(testRoot, { recursive: true, force: true });
});

describe("validateTopic", () => {
	it("合法 topic 通过", () => {
		for (const t of ["channel-automation", "abc", "Task_1.2", "a"]) {
			expect(validateTopic(t)).toBeNull();
		}
	});
	it("拒绝路径注入/隐藏目录/非法字符", () => {
		for (const t of ["", ".", "..", "../x", "/abs", "a/b", "a\\b", ".hidden", "-lead", "a b", "a:b"]) {
			expect(validateTopic(t)).not.toBeNull();
		}
	});
});

describe("ensureAgentWorkInit", () => {
	it("非 git 目录：建三子目录、gitignore=not-git、幂等", async () => {
		const cwd = join(testRoot, "plain");
		const r1 = await ensureAgentWorkInit(cwd);
		expect(r1.created).toHaveLength(4); // agent-work 根 + 3 子目录
		expect(channelRoot(cwd)).toContain(AGENT_WORK_REL);
		// 目录真实存在
		for (const d of [channelRoot(cwd), specRoot(cwd), planRoot(cwd)]) {
			const st = await stat(d);
			expect(st.isDirectory()).toBe(true);
		}
		const r2 = await ensureAgentWorkInit(cwd);
		expect(r2.created).toHaveLength(0);
		expect(r2.alreadyInitialized).toBe(true);
		expect(r2.gitignore).toBe("not-git");
	});

	it("git 仓库：追加精确行到 .gitignore，重复 init 不重复追加", async () => {
		const cwd = join(testRoot, "repo");
		await mkdir(cwd, { recursive: true });
		await execFileAsync("git", ["init", "-q"], { cwd });
		const r1 = await ensureAgentWorkInit(cwd);
		expect(r1.gitignore).toBe("appended");
		const content = await readFile(join(cwd, ".gitignore"), "utf8");
		expect(content).toContain(".local/agent-work/\n");
		// 幂等：第二次 check-ignore 命中
		const r2 = await ensureAgentWorkInit(cwd);
		expect(r2.gitignore).toBe("ignored");
		const content2 = await readFile(join(cwd, ".gitignore"), "utf8");
		expect(content2.match(/\.local\/agent-work\//g)?.length).toBe(1);
		// git check-ignore 确认真被忽略
		await expect(
			execFileAsync("git", ["check-ignore", "-q", AGENT_WORK_REL], { cwd }),
		).resolves.toBeDefined();
	});

	it("gitignore 已含无斜杠变体时不追加", async () => {
		const cwd = join(testRoot, "repo2");
		await mkdir(cwd, { recursive: true });
		await execFileAsync("git", ["init", "-q"], { cwd });
		await writeFile(join(cwd, ".gitignore"), ".local/agent-work\n", "utf8");
		const r = await ensureAgentWorkInit(cwd);
		expect(r.gitignore).toBe("ignored");
		const content = await readFile(join(cwd, ".gitignore"), "utf8");
		expect(content).not.toContain(".local/agent-work/\n");
	});

	it("spec/plan/topic 路径派生", async () => {
		const cwd = join(testRoot, "paths");
		expect(specRoot(cwd)).toBe(join(cwd, ".local/agent-work/spec"));
		expect(planRoot(cwd)).toBe(join(cwd, ".local/agent-work/plan"));
		expect(topicDir(cwd, "t1")).toBe(join(cwd, ".local/agent-work/channel/t1"));
	});
});
