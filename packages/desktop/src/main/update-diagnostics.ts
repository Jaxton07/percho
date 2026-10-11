import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { UpdateDiagnosticsInfo } from "@percho/shared";

const MAX_LOG_BYTES = 512 * 1024;

export interface UpdateEnvironment {
	version: string;
	platform: string;
	arch: string;
	osRelease: string;
	electron: string;
	pid: number;
	executable: string;
	installDirectory: string;
	userData: string;
	tempDirectory: string;
}
interface InstallAttempt {
	id: string;
	requestedAt: string;
	sourceVersion: string;
	targetVersion: string;
	trigger: "explicit" | "app-quit";
	outcome: UpdateDiagnosticsInfo["previousInstall"];
}

export interface UpdateDiagnosticReport {
	schemaVersion: number;
	generatedAt: string;
	environment: UpdateEnvironment;
	previousInstall: InstallAttempt | null;
	limitations: string[];
	logs: { updater: string; updaterPrevious: string; nsisPath: string | null; nsis: string };
}

/** 日志保留路径供定位；删除 URL 凭证/query/hash 及常见认证字段，绝不采集进程环境。 */
export function redactUpdateText(value: string): string {
	return value
		.replace(/(staging user ID:\s*)[\da-f-]+/gi, "$1[redacted]")
		.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
			try {
				const url = new URL(raw);
				url.username = "";
				url.password = "";
				url.search = "";
				url.hash = "";
				return url.toString();
			} catch {
				return "[redacted URL]";
			}
		})
		.replace(/(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]+/gi, "$1[redacted]")
		.replace(/((?:token|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]");
}

export function redactUpdateValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redactUpdateText(value);
	if (value instanceof Error) return redactUpdateText(value.stack ?? value.message);
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => redactUpdateValue(item, seen));
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			/^(?:authorization|token|password|api[_-]?key|cookie)$/i.test(key)
				? "[redacted]"
				: redactUpdateValue(item, seen),
		]),
	);
}

function logValue(value: unknown): string {
	if (value instanceof Error) return value.stack ?? value.message;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(redactUpdateValue(value)) ?? String(value);
	} catch {
		return "[unserializable]";
	}
}

/** 只读尾部，避免导出无限增长/异常文件；UTF-16 NSIS trace 与 UTF-8 updater log 分开解码。 */
export function readDiagnosticTail(path: string, encoding: "utf8" | "utf16le" = "utf8"): string {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		fd = openSync(path, "r");
		const start = Math.max(0, size - MAX_LOG_BYTES);
		const alignedStart = encoding === "utf16le" ? start + (start % 2) : start;
		const buffer = Buffer.alloc(size - alignedStart);
		const length = readSync(fd, buffer, 0, buffer.length, alignedStart);
		return redactUpdateText(
			`${alignedStart ? "[earlier entries truncated]\n" : ""}${buffer.subarray(0, length).toString(encoding)}`,
		);
	} catch {
		return "[not available]";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** 独立诊断，不 import Electron；IO 失败不能阻断正常更新/退出。记录同步落盘，退出前不依赖异步 flush。 */
export class UpdateDiagnostics {
	private attempt: InstallAttempt | null = null;
	private requestedThisRun = false;
	readonly logPath: string;
	private readonly attemptPath: string;

	constructor(
		readonly directory: string,
		readonly environment: UpdateEnvironment,
	) {
		this.logPath = join(directory, "updater.jsonl");
		this.attemptPath = join(directory, "install-attempt.json");
		try {
			const value = JSON.parse(readFileSync(this.attemptPath, "utf8"));
			if (
				value &&
				typeof value.id === "string" &&
				typeof value.requestedAt === "string" &&
				typeof value.sourceVersion === "string" &&
				typeof value.targetVersion === "string" &&
				["explicit", "app-quit"].includes(value.trigger)
			) {
				this.attempt = {
					id: value.id,
					requestedAt: value.requestedAt,
					sourceVersion: value.sourceVersion,
					targetVersion: value.targetVersion,
					trigger: value.trigger,
					outcome:
						environment.version === value.targetVersion
							? "target-running"
							: environment.version === value.sourceVersion
								? "unconfirmed"
								: "version-changed",
				};
				this.persistAttempt();
			}
		} catch {
			// 未升级过/旧版没有诊断记录/损坏记录均不推断失败。
		}
		this.record("app-start", environment);
		if (this.attempt) this.record("previous-install-observation", this.attempt);
	}

	record(event: string, ...details: unknown[]): void {
		try {
			mkdirSync(this.directory, { recursive: true });
			if (existsSync(this.logPath) && statSync(this.logPath).size > MAX_LOG_BYTES) {
				const rotated = `${this.logPath}.1`;
				if (existsSync(rotated)) unlinkSync(rotated);
				renameSync(this.logPath, rotated);
			}
			appendFileSync(
				this.logPath,
				`${JSON.stringify({
					time: new Date().toISOString(),
					pid: this.environment.pid,
					event,
					details: redactUpdateText(details.map(logValue).join(" ")).slice(0, 16_384),
				})}\n`,
			);
		} catch {
			// 诊断目录不可写时也不能让下载/关闭失效。
		}
	}

	beginInstall(targetVersion: string, trigger: InstallAttempt["trigger"]): void {
		if (this.requestedThisRun) return;
		this.requestedThisRun = true;
		this.attempt = {
			id: randomUUID(),
			requestedAt: new Date().toISOString(),
			sourceVersion: this.environment.version,
			targetVersion,
			trigger,
			outcome: "unconfirmed",
		};
		this.persistAttempt();
		this.record("install-handoff-requested", this.attempt);
	}

	private persistAttempt(): void {
		try {
			mkdirSync(this.directory, { recursive: true });
			const temporary = `${this.attemptPath}.${this.environment.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify(this.attempt, null, 2));
			renameSync(temporary, this.attemptPath);
		} catch {
			// 诊断状态不是安装控制状态。
		}
	}

	getInfo(): UpdateDiagnosticsInfo {
		return {
			previousInstall: this.attempt?.outcome ?? "none",
			targetVersion: this.attempt?.targetVersion ?? null,
		};
	}

	/** 有意不带主日志/会话/认证文件，也不把未确认交接归因到 NSIS 的具体失败。 */
	report(nsisTracePath?: string): UpdateDiagnosticReport {
		return {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			environment: this.environment,
			previousInstall: this.attempt,
			limitations: [
				"An install handoff is not proof of installer success or failure.",
				"The updater cannot observe an external NSIS dialog or the old uninstaller's internal file failure.",
				"NSIS tracing starts with the first installer containing this diagnostic patch; old packages have no trace.",
				"An updater may skip automatic installation on a nonzero app exit code; inspect app-quit and SDK entries.",
				"An installer elevated with another account may write its NSIS trace under that account's LOCALAPPDATA.",
				"Paths may contain your Windows account name. Review before sharing; nothing is uploaded automatically.",
			],
			logs: {
				updater: readDiagnosticTail(this.logPath),
				updaterPrevious: readDiagnosticTail(`${this.logPath}.1`),
				nsisPath: nsisTracePath ?? null,
				nsis: nsisTracePath ? readDiagnosticTail(nsisTracePath, "utf16le") : "[not applicable]",
			},
		};
	}
}
