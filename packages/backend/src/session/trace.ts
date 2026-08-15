import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../log";

const log = createLogger("trace");

const FLUSH_INTERVAL_MS = 500;
const FLUSH_BATCH_SIZE = 128;
/** 单 trace 文件超过该大小后轮转归档（按 sessionId 保留最近 5 份） */
const ROTATE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVED = 5;

/**
 * 会话事件 trace：把 AgentSessionEvent 逐条批量写入 JSONL。
 * 事件流是 reducer 的输入，trace 文件可离线重放（scripts/replay-trace.mts）
 * 确定性复现 UI 状态问题。文件与会话同目录：trace-<sessionId>.jsonl；
 * 超限轮转为 trace-<sessionId>.<ts>.jsonl，保留最近 MAX_ARCHIVED 份。
 */
export class TraceRecorder {
	private readonly buffer: string[] = [];
	private readonly timer: NodeJS.Timeout;
	private closed = false;

	private constructor(
		private readonly filePath: string,
		flushIntervalMs = FLUSH_INTERVAL_MS,
	) {
		this.timer = setInterval(() => this.flush(), flushIntervalMs);
		this.timer.unref();
	}

	/** 在会话目录创建 recorder（目录不存在则创建；已有超大文件先轮转） */
	static async create(sessionDir: string, sessionId: string): Promise<TraceRecorder> {
		const dir = join(sessionDir, "traces");
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, `trace-${sessionId}.jsonl`);
		await rotateIfLarge(filePath, dir, sessionId);
		await sweepArchived(dir, sessionId);
		const recorder = new TraceRecorder(filePath);
		log.debug("trace started", filePath);
		return recorder;
	}

	/** 删除会话的全部 trace（deleteSession 时调用，含归档） */
	static async removeAll(sessionDir: string, sessionId: string): Promise<void> {
		const dir = join(sessionDir, "traces");
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			return;
		}
		const prefix = `trace-${sessionId}`;
		for (const file of files) {
			if (!file.startsWith(prefix) || !file.endsWith(".jsonl")) continue;
			await unlink(join(dir, file)).catch(() => {});
		}
	}

	record(event: unknown): void {
		if (this.closed) return;
		this.buffer.push(JSON.stringify(event));
		if (this.buffer.length >= FLUSH_BATCH_SIZE) void this.flush();
	}

	/** 落盘并停止定时刷新（closeSession 时调用） */
	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.timer);
		await this.flush();
	}

	private async flush(): Promise<void> {
		if (this.buffer.length === 0) return;
		const chunk = `${this.buffer.join("\n")}\n`;
		this.buffer.length = 0;
		try {
			await appendFile(this.filePath, chunk, "utf-8");
		} catch (err) {
			log.error("trace write failed", this.filePath, err);
		}
	}
}

/** 已有文件超过大小上限 → 重命名为归档文件 */
async function rotateIfLarge(filePath: string, dir: string, sessionId: string): Promise<void> {
	try {
		const { size } = await stat(filePath);
		if (size < ROTATE_SIZE_BYTES) return;
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		await rename(filePath, join(dir, `trace-${sessionId}.${ts}.jsonl`));
	} catch {
		// 不存在/失败都无需处理
	}
}

/** 只保留最近 MAX_ARCHIVED 份归档（按修改时间），活跃文件不在此列 */
async function sweepArchived(dir: string, sessionId: string): Promise<void> {
	const prefix = `trace-${sessionId}.`;
	try {
		const files = (
			await Promise.all(
				(
					await readdir(dir)
				)
					.filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
					.map(async (f) => {
						const path = join(dir, f);
						const { mtime } = await stat(path);
						return { path, mtime: mtime.getTime() };
					}),
			)
		).sort((a, b) => b.mtime - a.mtime);
		for (const file of files.slice(MAX_ARCHIVED)) {
			await unlink(file.path).catch(() => {});
		}
	} catch {
		// 清理失败不影响主流程
	}
}
