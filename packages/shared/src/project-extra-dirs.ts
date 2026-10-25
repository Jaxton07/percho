/** 空值常量（共享稳定引用：Zustand selector 直接返回它，不新建数组） */
export const EMPTY_EXTRA_DIRS: string[] = [];

/** 每项目额外目录上限：这些路径会原样进系统提示词，不设限会挤占上下文 */
export const MAX_PROJECT_EXTRA_DIRS = 16;

/**
 * 绝对路径判断（**不依赖 `node:path`**：main 与 renderer 共用同一份规则）：
 * POSIX `/…`、Windows 盘符 `C:\` / `C:/`、UNC `\\…`。相对路径一律不收——模型拿到的必须是可直接访问的路径。
 */
export function isAbsoluteDirPath(path: string): boolean {
	return path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path);
}

/**
 * 项目额外目录清洗（**规则唯一实现**，main 读文件与 renderer 写入前各跑一次）：
 * 非数组 → 空；`trim` → 去空 → 去重（保序）→ **丢弃等于 cwd 的项**（首个目录本就是 cwd）→
 * 只收绝对路径 → 上限 `MAX_PROJECT_EXTRA_DIRS`。
 */
export function cleanProjectExtraDirs(cwd: string, dirs: unknown): string[] {
	if (!Array.isArray(dirs)) return EMPTY_EXTRA_DIRS;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of dirs) {
		if (typeof item !== "string") continue;
		const path = item.trim();
		if (path === "" || path === cwd || !isAbsoluteDirPath(path) || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
		if (out.length >= MAX_PROJECT_EXTRA_DIRS) break;
	}
	return out.length === 0 ? EMPTY_EXTRA_DIRS : out;
}
