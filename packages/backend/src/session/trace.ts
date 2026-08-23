import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../log";

const log = createLogger("trace");

const FLUSH_INTERVAL_MS = 500;
const FLUSH_BATCH_SIZE = 128;
/** 单 trace 文件超过该大小后轮转归档（按 sessionId 保留最近 5 份） */
const ROTATE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVED = 5;
/** 单事件序列化长度上限：超过只记一行截断标记（防巨型快照事件，保持 JSONL 可回放） */
const MAX_EVENT_BYTES = 512 * 1024;
/** flush 失败/停滞时缓冲兜底上限：超过丢弃最旧并记标记，绝不让 buffer 无界增长 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface TraceLimits {
	flushIntervalMs?: number;
	rotateSizeBytes?: number;
	maxEventBytes?: number;
	maxBufferBytes?: number;
}

/**
 * 会话事件 trace：把事件逐条批量写入 JSONL。
 * 事件流是 reducer 的输入，trace 文件可离线重放（scripts/replay-trace.mts）
 * 确定性复现 UI 状态问题。文件与会话同目录：trace-<sessionId>.jsonl；
 * 超限轮转为 trace-<sessionId>.<ts>.jsonl，保留最近 MAX_ARCHIVED 份。
 *
 * 0.4.6 冻结事故加固：巨型事件截断标记、join 失败丢弃整批（绝不重试同一批）、
 * flush 后按已写字节轮转（会话进行中也会轮转，不再只查一次）、缓冲字节兜底。
 * 截断标记行的 type 一律为合成值 "trace_gap"（真实类型记 originalType）：reducer
 * 遇未知类型 no-op，replay-trace.mts 重放含标记行的事故 trace 不会把标记当真事件
 * 解引用而崩溃（message_start/message_update 分支会直接访问 .message/.assistantMessageEvent）。
 */
export class TraceRecorder {
	private readonly buffer: string[] = [];
	private bufferBytes = 0;
	private readonly timer: NodeJS.Timeout;
	private closed = false;
	private flushing = false;
	/** 活跃文件已写字节（flush 后累加，轮转清零）；create 时从磁盘尺寸起算 */
	private sizeBytes = 0;

	private constructor(
		private readonly filePath: string,
		private readonly sessionId: string,
		private readonly limits: Required<
			Pick<TraceLimits, "rotateSizeBytes" | "maxEventBytes" | "maxBufferBytes">
		>,
		flushIntervalMs: number,
	) {
		this.timer = setInterval(() => this.flush(), flushIntervalMs);
		this.timer.unref();
	}

	/** 在会话目录创建 recorder（目录不存在则创建；已有超大文件先轮转） */
	static async create(sessionDir: string, sessionId: string, limits?: TraceLimits): Promise<TraceRecorder> {
		const dir = join(sessionDir, "traces");
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, `trace-${sessionId}.jsonl`);
		const resolved = {
			rotateSizeBytes: limits?.rotateSizeBytes ?? ROTATE_SIZE_BYTES,
			maxEventBytes: limits?.maxEventBytes ?? MAX_EVENT_BYTES,
			maxBufferBytes: limits?.maxBufferBytes ?? MAX_BUFFER_BYTES,
		};
		await rotateIfLarge(filePath, dir, sessionId, resolved.rotateSizeBytes);
		await sweepArchived(dir, sessionId);
		const recorder = new TraceRecorder(
			filePath,
			sessionId,
			resolved,
			limits?.flushIntervalMs ?? FLUSH_INTERVAL_MS,
		);
		recorder.sizeBytes = await stat(filePath)
			.then((s) => s.size)
			.catch(() => 0);
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
		let line: string;
		try {
			line = JSON.stringify(event) ?? "null";
		} catch (err) {
			log.warn("trace serialize failed", this.filePath, err);
			return;
		}
		if (line.length > this.limits.maxEventBytes) {
			// 巨型事件（异常快照等）：只记截断标记，不落巨型行；保持每行可 JSON.parse。
			// type 用合成值 trace_gap（reducer no-op），真实类型放 originalType（见文件头注释）。
			const originalType = JSON.stringify((event as { type?: unknown })?.type ?? "unknown");
			line = `{"_truncated":true,"type":"trace_gap","originalType":${originalType},"bytes":${line.length}}`;
		}
		this.buffer.push(line);
		this.bufferBytes += line.length;
		this.compactBuffer();
		if (this.buffer.length >= FLUSH_BATCH_SIZE) void this.flush();
	}

	/** 落盘并停止定时刷新（closeSession 时调用） */
	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.timer);
		// 等在途 flush 完成后再做最后一次落盘，避免 buffer 尾部丢失
		while (this.flushing) await new Promise((resolve) => setTimeout(resolve, 5));
		await this.flush();
	}

	private async flush(): Promise<void> {
		if (this.flushing || this.buffer.length === 0) return;
		this.flushing = true;
		let chunk: string;
		try {
			chunk = `${this.buffer.join("\n")}\n`;
		} catch (err) {
			// join 本身失败（单条超长触发分配上限）：丢弃整批记标记，绝不重试同一批
			log.error("trace flush join failed, batch dropped", this.filePath, err);
			chunk = `{"_truncated":true,"type":"trace_gap","reason":"flush_join_failed"}\n`;
		}
		this.buffer.length = 0;
		this.bufferBytes = 0;
		try {
			await appendFile(this.filePath, chunk, "utf-8");
			this.sizeBytes += Buffer.byteLength(chunk, "utf-8");
			// 会话进行中也会轮转（旧版只在 open 时查一次，事故里单文件涨到 12.7GB）
			if (this.sizeBytes >= this.limits.rotateSizeBytes) await this.rotateNow();
		} catch (err) {
			// 写失败（磁盘满等）：本批已丢弃，不重试——trace 是诊断数据，宁缺勿卡
			log.error("trace write failed", this.filePath, err);
		} finally {
			this.flushing = false;
		}
	}

	/** 把活跃文件归档并重置计数；下一条 appendFile 自然新建 */
	private async rotateNow(): Promise<void> {
		try {
			const dir = dirname(this.filePath);
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			await rename(this.filePath, join(dir, `trace-${this.sessionId}.${ts}.jsonl`));
			this.sizeBytes = 0;
			await sweepArchived(dir, this.sessionId);
		} catch (err) {
			log.warn("trace rotate failed", this.filePath, err);
		}
	}

	/** 缓冲字节超上限：丢最旧保最新，并留一行标记（磁盘写停滞时防无界增长） */
	private compactBuffer(): void {
		if (this.bufferBytes <= this.limits.maxBufferBytes || this.buffer.length === 0) return;
		let dropped = 0;
		while (this.bufferBytes > this.limits.maxBufferBytes && this.buffer.length > 1) {
			const line = this.buffer.shift();
			if (line === undefined) break;
			this.bufferBytes -= line.length;
			dropped++;
		}
		const marker = `{"_truncated":true,"type":"trace_gap","reason":"buffer_overflow","dropped":${dropped}}`;
		this.buffer.unshift(marker);
		this.bufferBytes += marker.length;
	}
}

/** 已有文件超过大小上限 → 重命名为归档文件 */
async function rotateIfLarge(
	filePath: string,
	dir: string,
	sessionId: string,
	maxBytes: number,
): Promise<void> {
	try {
		const { size } = await stat(filePath);
		if (size < maxBytes) return;
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
