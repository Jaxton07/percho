import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createLogger } from "./log";

const log = createLogger("workspace-store");

/** 每项目记忆条目上限（最旧淘汰；防无界增长） */
const MAX_ALLOWED_PATTERNS = 200;

/** 工作区配置（~/.pi/agent/workspaces.json，用户级）：多项目根 + 项目级 allowAlways 记忆 */
export interface WorkspaceProjectEntry {
	/** 额外信任根（绝对路径）：根内路径视为界内 */
	roots: string[];
	/** 项目级 allowAlways 记忆（suggestPattern 模式键，如 "bash: git push*"、"write: /dir/*"） */
	allowed: string[];
}

export interface WorkspacesConfig {
	version: 1;
	projects: Record<string, WorkspaceProjectEntry>;
}

export function emptyWorkspaces(): WorkspacesConfig {
	return { version: 1, projects: {} };
}

export function workspaceConfigPath(agentDir: string): string {
	return join(agentDir, "workspaces.json");
}

function parseEntry(raw: unknown): WorkspaceProjectEntry | null {
	if (typeof raw !== "object" || raw === null) return null;
	const input = raw as { roots?: unknown; allowed?: unknown };
	const roots = Array.isArray(input.roots)
		? input.roots.filter((r): r is string => typeof r === "string" && r.length > 0)
		: [];
	const allowed = Array.isArray(input.allowed)
		? input.allowed.filter((p): p is string => typeof p === "string" && p.length > 0)
		: [];
	return { roots, allowed };
}

/** 读取工作区配置；文件不存在/非法时返回空配置（不抛错） */
export function loadWorkspaces(agentDir: string): WorkspacesConfig {
	const path = workspaceConfigPath(agentDir);
	if (!existsSync(path)) return emptyWorkspaces();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as { projects?: unknown };
		if (typeof raw !== "object" || raw === null || typeof raw.projects !== "object") {
			return emptyWorkspaces();
		}
		const config = emptyWorkspaces();
		for (const [root, entry] of Object.entries(raw.projects as Record<string, unknown>)) {
			if (!isAbsolute(root)) continue;
			const parsed = parseEntry(entry);
			if (parsed) config.projects[root] = parsed;
		}
		return config;
	} catch (err) {
		log.warn("workspaces.json 解析失败，按空配置处理", path, err);
		return emptyWorkspaces();
	}
}

/** 原子写（tmp + rename）；读改写窗口的并发竞态最坏丢一条记忆，可接受 */
function saveWorkspaces(agentDir: string, config: WorkspacesConfig): void {
	const path = workspaceConfigPath(agentDir);
	mkdirSync(agentDir, { recursive: true });
	const tmp = join(tmpdir(), `workspaces-${process.pid}-${Date.now()}.json`);
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
}

function mutateEntry(agentDir: string, projectRoot: string, mutate: (entry: WorkspaceProjectEntry) => void) {
	const key = resolve(projectRoot);
	const config = loadWorkspaces(agentDir);
	const entry = config.projects[key] ?? { roots: [], allowed: [] };
	mutate(entry);
	if (entry.roots.length === 0 && entry.allowed.length === 0) {
		delete config.projects[key]; // 空条目回收，避免积累空对象
	} else {
		config.projects[key] = entry;
	}
	saveWorkspaces(agentDir, config);
}

/** 把 newRoot 加入项目的额外信任根（去重） */
export function addWorkspaceRoot(agentDir: string, projectRoot: string, newRoot: string): void {
	const root = resolve(newRoot);
	mutateEntry(agentDir, projectRoot, (entry) => {
		if (!entry.roots.includes(root)) entry.roots.push(root);
	});
	log.info("workspace root added", { projectRoot: resolve(projectRoot), root });
}

/** 移除项目的额外信任根 */
export function removeWorkspaceRoot(agentDir: string, projectRoot: string, root: string): void {
	const target = resolve(root);
	mutateEntry(agentDir, projectRoot, (entry) => {
		entry.roots = entry.roots.filter((r) => r !== target);
	});
	log.info("workspace root removed", { projectRoot: resolve(projectRoot), root: target });
}

/** 记录项目级 allowAlways 模式（去重；超限淘汰最旧） */
export function addAllowedPattern(agentDir: string, projectRoot: string, pattern: string): void {
	mutateEntry(agentDir, projectRoot, (entry) => {
		entry.allowed = entry.allowed.filter((p) => p !== pattern);
		entry.allowed.push(pattern);
		if (entry.allowed.length > MAX_ALLOWED_PATTERNS) {
			entry.allowed = entry.allowed.slice(entry.allowed.length - MAX_ALLOWED_PATTERNS);
		}
	});
	log.info("permission pattern remembered", { projectRoot: resolve(projectRoot), pattern });
}

/** mtime 缓存的配置读取（权限扩展每次 tool_call 前调用，修改即时生效） */
export function createWorkspacesLoader(agentDir: string): () => WorkspacesConfig {
	let cached: { mtimeMs: number | null; config: WorkspacesConfig } | undefined;
	return () => {
		const path = workspaceConfigPath(agentDir);
		let mtimeMs: number | null = null;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			mtimeMs = null;
		}
		if (cached && cached.mtimeMs === mtimeMs) return cached.config;
		const config = loadWorkspaces(agentDir);
		cached = { mtimeMs, config };
		return config;
	};
}

/**
 * 「允许此目录」的候选根启发式：从路径父目录向上找最近含 .git 的目录；
 * 无 .git 用父目录。home 本身/home 的祖先绝不作为根（防整个家目录放行）。
 */
export function suggestRootCandidate(absPath: string, home: string = homedir()): string | null {
	const unsafe = (dir: string): boolean =>
		dir === "/" || dir === home || home.startsWith(dir + sep) || dir === dirname(home);

	const parent = dirname(absPath);
	if (unsafe(parent)) return null;
	let dir = parent;
	for (;;) {
		if (existsSync(join(dir, ".git")) && !unsafe(dir)) return dir;
		const up = dirname(dir);
		if (up === dir) return parent;
		dir = up;
	}
}
