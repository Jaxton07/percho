import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * 结构化日志：级别过滤 + console（TTY 带色）+ 可选文件落盘。
 * 文件目录由 initLogging 注入（缺省读 PI_LOG_DIR 环境变量），
 * 按天分文件：main-<yyyy-mm-dd>.log；启动时清理 7 天前的日志。
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 日志保留天数 */
const MAX_LOG_DAYS = 7;

let minLevel: Level = (process.env.PI_LOG_LEVEL as Level | undefined) ?? "info";
let logDir: string | undefined = process.env.PI_LOG_DIR;
let logFilePath: string | undefined;

/**
 * 本地墙上时间 + 显式时区偏移（ISO 8601 `±HH:MM`）：本地可直接读、偏移无歧义（看 `+08:00` 不用心算 UTC+8）、
 * ASCII 尾缀不影响前缀区间比较（字典序可排序）。旧文件是 UTC `Z` 尾缀，格式自带判别，互不冲突。
 */
export function formatTimestamp(d: Date): string {
	const p = (n: number, w = 2): string => String(n).padStart(w, "0");
	const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
		d.getMinutes(),
	)}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
	const offsetMin = d.getTimezoneOffset(); // UTC+8 → -480；正数 = 本地在 UTC 以西
	const sign = offsetMin <= 0 ? "+" : "-";
	const abs = Math.abs(offsetMin);
	return `${local}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export function initLogging(dir?: string, level?: Level): void {
	if (dir) logDir = dir;
	if (level) minLevel = level;
	if (logDir) {
		// 文件名日期同步改本地日（与行内时间戳同一基准；sweepOldLogs 的 main-YYYY-MM-DD.log 正则不变）
		const date = formatTimestamp(new Date()).slice(0, 10);
		logFilePath = join(logDir, `main-${date}.log`);
		mkdirSync(logDir, { recursive: true });
		sweepOldLogs();
	}
}

/** 删除超过保留期的 main-<date>.log（按 mtime 判定） */
function sweepOldLogs(): void {
	const dir = logDir;
	if (!dir) return;
	try {
		const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
		for (const file of readdirSync(dir)) {
			if (!/^main-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
			const path = join(dir, file);
			if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
		}
	} catch {
		// 清理失败不影响主流程
	}
}

const COLOR: Record<Level, string> = {
	debug: "\x1b[90m",
	info: "\x1b[36m",
	warn: "\x1b[33m",
	error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function formatArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (a instanceof Error) return a.stack ?? a.message;
			if (typeof a === "string") return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

/** 创建带模块 tag 的 logger */
export function createLogger(tag: string): Logger {
	const write = (level: Level, message: string, args: unknown[]) => {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
		const ts = formatTimestamp(new Date());
		const line = `${ts} ${level.padEnd(5)} [${tag}] ${message}${args.length > 0 ? ` ${formatArgs(args)}` : ""}`;
		if (process.stdout.isTTY) {
			process.stdout.write(`${COLOR[level]}${line}${RESET}\n`);
		} else {
			process.stdout.write(`${line}\n`);
		}
		if (logFilePath) {
			try {
				appendFileSync(logFilePath, `${line}\n`);
			} catch {
				// 日志写失败不影响主流程
			}
		}
	};
	return {
		debug: (m, ...a) => write("debug", m, a),
		info: (m, ...a) => write("info", m, a),
		warn: (m, ...a) => write("warn", m, a),
		error: (m, ...a) => write("error", m, a),
	};
}
