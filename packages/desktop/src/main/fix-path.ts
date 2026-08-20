import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "@percho/backend";

const log = createLogger("fix-path");

/**
 * GUI 启动 PATH 修复（macOS / Linux；Windows 注册表 PATH 无此问题，整体跳过）。
 *
 * 背景（issue #18）：从 Finder/Dock 启动的应用不读 shell 配置，PATH 只有 launchd
 * 默认值（/usr/bin:/bin:/usr/sbin:/sbin），不含 Homebrew（/opt/homebrew/bin）等
 * 用户目录。pi SDK 安装扩展时 spawn 裸 "npm" 依赖 PATH 解析 → spawn npm ENOENT。
 *
 * 两段式（import 即生效，须在 spawn 任何子进程之前 import 本模块）：
 * 1. 同步追加已知常见 bin 目录（存在才加，毫秒级，覆盖 Homebrew/官方安装包/常见版本管理器）
 * 2. 异步用登录交互 shell 解析用户真实 PATH，把缺失条目合并进来
 *    （覆盖任意自定义安装位置；npm 的 spawn 发生在用户点安装之后，异步解析来得及）
 */

/** 常见用户级 bin 目录候选（按平台；返回未必存在的路径，调用方过滤） */
export function wellKnownBinDirs(platform: NodeJS.Platform, home: string): string[] {
	if (platform === "darwin") {
		return [
			"/opt/homebrew/bin", // Homebrew（Apple Silicon）
			"/opt/homebrew/sbin",
			"/usr/local/bin", // Homebrew（Intel）/ 官方 pkg 安装器
			"/usr/local/sbin",
			`${home}/.local/bin`,
			`${home}/.volta/bin`,
			`${home}/.asdf/shims`,
			`${home}/Library/pnpm`,
			`${home}/.bun/bin`,
		];
	}
	if (platform === "linux") {
		return [`${home}/.local/bin`, "/usr/local/bin", "/snap/bin", `${home}/.volta/bin`, `${home}/.asdf/shims`];
	}
	return [];
}

/** 合并 PATH：保留 current 全部条目与顺序，追加 extra 中未出现的非空条目 */
export function mergePath(current: string, extra: string[]): string {
	const entries = current.split(":").filter((e) => e.length > 0);
	const seen = new Set(entries);
	for (const dir of extra) {
		if (!dir || seen.has(dir)) continue;
		seen.add(dir);
		entries.push(dir);
	}
	return entries.join(":");
}

/** 从 shell `env` 输出中提取 PATH（rc 打印的杂讯行直接忽略，shell 无关：zsh/bash/fish 通用） */
export function parseShellEnvPath(output: string): string | null {
	for (const line of output.split("\n")) {
		if (line.startsWith("PATH=")) {
			const value = line.slice("PATH=".length).trim();
			if (value.length > 0) return value;
		}
	}
	return null;
}

/** 同步段：把存在的常见 bin 目录追加进 process.env.PATH */
function fixPathSync(): void {
	const candidates = wellKnownBinDirs(process.platform, homedir()).filter((dir) => existsSync(dir));
	const merged = mergePath(process.env.PATH ?? "", candidates);
	if (merged !== process.env.PATH) {
		process.env.PATH = merged;
		log.info("PATH 已追加常见 bin 目录", candidates);
	}
}

/** 异步段：登录交互 shell（-ilc）解析用户真实 PATH，缺失条目合并进 process.env.PATH */
function fixPathFromLoginShell(): void {
	const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
	// `command env` 而非 `echo $PATH`：fish 下 $PATH 是列表会拼成空格分隔，env 输出对所有 shell 一致
	execFile(shell, ["-ilc", "command env"], { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
		if (error) {
			log.warn("登录 shell PATH 解析失败（保留同步段结果）", error.message);
			return;
		}
		const shellPath = parseShellEnvPath(stdout);
		if (!shellPath) {
			log.warn("登录 shell 输出中未找到 PATH");
			return;
		}
		const merged = mergePath(process.env.PATH ?? "", shellPath.split(":"));
		if (merged !== process.env.PATH) {
			process.env.PATH = merged;
			log.info("PATH 已合并登录 shell 条目", { shell });
		}
	});
}

if (process.platform !== "win32") {
	fixPathSync();
	fixPathFromLoginShell();
}
