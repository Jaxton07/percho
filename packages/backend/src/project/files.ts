import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/** 遍历排除项（重型依赖/构建产物/版本控制目录） */
const EXCLUDED_DIRS = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"coverage",
	".idea",
	".vscode",
	"target",
	"vendor",
	"__pycache__",
	".venv",
	"venv",
	".gradle",
]);

/** 大项目截断上限（超出部分不进入 @ 搜索） */
const MAX_ENTRIES = 5000;
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
	files: string[];
	at: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * 递归列出项目相对路径（目录带尾 "/" 供 @ 菜单继续钻取）。
 * 按 cwd 做 TTL 缓存；符号链接不跟随（防环）；无权限目录跳过。
 */
export async function walkProjectFiles(cwd: string): Promise<string[]> {
	const root = resolve(cwd);
	const hit = cache.get(root);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;

	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		if (out.length >= MAX_ENTRIES) return;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (out.length >= MAX_ENTRIES) return;
			const full = join(dir, entry.name);
			const rel = relative(root, full).split(sep).join("/");
			if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.has(entry.name)) continue;
				out.push(`${rel}/`);
				await walk(full);
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	};
	await walk(root);
	cache.set(root, { files: out, at: Date.now() });
	return out;
}
