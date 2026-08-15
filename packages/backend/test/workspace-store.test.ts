import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addAllowedPattern,
	addWorkspaceRoot,
	createWorkspacesLoader,
	emptyWorkspaces,
	loadWorkspaces,
	removeWorkspaceRoot,
	suggestRootCandidate,
	workspaceConfigPath,
} from "../src/project/workspace-store";

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ws-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("workspace-store", () => {
	it("无文件 → 空配置；写后 roundtrip", () => {
		const dir = makeAgentDir();
		expect(loadWorkspaces(dir)).toEqual(emptyWorkspaces());
		addWorkspaceRoot(dir, "/proj", "/other/repo");
		expect(loadWorkspaces(dir)).toEqual({
			version: 1,
			projects: { "/proj": { roots: ["/other/repo"], allowed: [] } },
		});
	});

	it("根去重；移除后空条目回收", () => {
		const dir = makeAgentDir();
		addWorkspaceRoot(dir, "/proj", "/other");
		addWorkspaceRoot(dir, "/proj", "/other"); // 去重
		addAllowedPattern(dir, "/proj", "bash: git push*");
		expect(loadWorkspaces(dir).projects["/proj"].roots).toEqual(["/other"]);
		removeWorkspaceRoot(dir, "/proj", "/other");
		const afterRemove = loadWorkspaces(dir);
		expect(afterRemove.projects["/proj"]).toEqual({ roots: [], allowed: ["bash: git push*"] });
		// 移除最后记忆后条目整体回收
		const raw = JSON.parse(readFileSync(workspaceConfigPath(dir), "utf-8"));
		raw.projects["/proj"] = { roots: [], allowed: [] };
		writeFileSync(workspaceConfigPath(dir), JSON.stringify(raw));
		removeWorkspaceRoot(dir, "/proj", "/nonexistent");
		expect(loadWorkspaces(dir).projects["/proj"]).toBeUndefined();
	});

	it("记忆去重后移到末尾（LRU 语义）；非法文件回退空配置", () => {
		const dir = makeAgentDir();
		addAllowedPattern(dir, "/p", "a*");
		addAllowedPattern(dir, "/p", "b*");
		addAllowedPattern(dir, "/p", "a*");
		expect(loadWorkspaces(dir).projects["/p"].allowed).toEqual(["b*", "a*"]);
		writeFileSync(workspaceConfigPath(dir), "{broken");
		expect(loadWorkspaces(dir)).toEqual(emptyWorkspaces());
	});

	it("mtime 加载器：文件变更后重新读取", () => {
		const dir = makeAgentDir();
		const load = createWorkspacesLoader(dir);
		expect(load()).toEqual(emptyWorkspaces());
		addWorkspaceRoot(dir, "/proj", "/other");
		expect(load().projects["/proj"]).toEqual({ roots: ["/other"], allowed: [] });
	});
});

describe("suggestRootCandidate", () => {
	it("向上找最近 .git 根", () => {
		const dir = makeAgentDir();
		const repo = join(dir, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "a", "b"), { recursive: true });
		const home = join(dir, "home");
		expect(suggestRootCandidate(join(repo, "a", "b", "f.ts"), home)).toBe(repo);
	});

	it("无 .git → 父目录；home/home 祖先/根目录绝不作为候选", () => {
		const dir = makeAgentDir();
		const home = join(dir, "home");
		mkdirSync(join(home, "work", "note"), { recursive: true });
		// 无 .git：父目录
		expect(suggestRootCandidate(join(home, "work", "note", "a.md"), home)).toBe(join(home, "work", "note"));
		// 父目录即 home → null（绝不放行整个家目录）
		expect(suggestRootCandidate(join(home, "todo.md"), home)).toBeNull();
		// 父目录是 home 的祖先 → null（不慎放行 /Users 级别目录）
		expect(suggestRootCandidate(join(dir, "x.md"), home)).toBeNull();
		expect(suggestRootCandidate("/f.ts", home)).toBeNull();
	});

	it("home 下有 .git 也不返回 home（目录而非文件路径的场景同样安全）", () => {
		const dir = makeAgentDir();
		const home = join(dir, "home");
		mkdirSync(join(home, ".git"), { recursive: true });
		mkdirSync(join(home, "sub"), { recursive: true });
		// 从 home/sub/x 向上找到 home 的 .git，但 home 不安全 → 继续向上无 .git → 父目录
		expect(suggestRootCandidate(join(home, "sub", "x"), home)).toBe(join(home, "sub"));
	});
});
