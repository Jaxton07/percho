import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";

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

/** 原始 JSON → 规整配置：非绝对路径根/非法条目剔除（loadWorkspaces 读侧与 mutateEntry 写侧共用） */
function parseWorkspaces(raw: unknown): WorkspacesConfig {
	const config = emptyWorkspaces();
	if (typeof raw !== "object" || raw === null) return config;
	const projects = (raw as { projects?: unknown }).projects;
	if (typeof projects !== "object" || projects === null) return config;
	for (const [root, entry] of Object.entries(projects as Record<string, unknown>)) {
		if (!isAbsolute(root)) continue;
		const parsed = parseEntry(entry);
		if (parsed) config.projects[root] = parsed;
	}
	return config;
}

/** 读取工作区配置；文件不存在/非法时返回空配置（不抛错） */
export function loadWorkspaces(agentDir: string): WorkspacesConfig {
	const store = workspacesStore(agentDir);
	return parseWorkspaces(store.readSync());
}

function workspacesStore(agentDir: string): JsonStore<unknown> {
	return new JsonStore<unknown>({
		path: workspaceConfigPath(agentDir),
		defaultValue: () => null,
	});
}

/**
 * 读改写（sync，权限应答热路径）：同目录 tmp+rename 原子写（修跨卷 EXDEV）；
 * 文件损坏时抛 JsonStoreCorruptedError 拒写（静默继续会用空配置覆盖真记忆），
 * 调用方（respondPermission）负责 catch 呈现。
 */
function mutateEntry(agentDir: string, projectRoot: string, mutate: (entry: WorkspaceProjectEntry) => void) {
	const store = workspacesStore(agentDir);
	store.updateSync((raw) => {
		const config = parseWorkspaces(raw);
		const key = resolve(projectRoot);
		const entry = config.projects[key] ?? { roots: [], allowed: [] };
		mutate(entry);
		if (entry.roots.length === 0 && entry.allowed.length === 0) {
			delete config.projects[key]; // 空条目回收，避免积累空对象
		} else {
			config.projects[key] = entry;
		}
		return config;
	});
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
