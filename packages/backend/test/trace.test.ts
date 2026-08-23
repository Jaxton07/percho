import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceRecorder } from "../src/session/trace";

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "percho-trace-"));
	dirs.push(dir);
	return dir;
}

/** 读全部行（活跃 + 归档，在 traces/ 子目录），按文件名排序 */
async function allLines(dir: string, sessionId: string): Promise<string[]> {
	const lines: string[] = [];
	const traceDir = join(dir, "traces");
	for (const f of await readdir(traceDir)) {
		if (!f.startsWith(`trace-${sessionId}`) || !f.endsWith(".jsonl")) continue;
		lines.push(...(await readFile(join(traceDir, f), "utf8")).split("\n").filter(Boolean));
	}
	return lines;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("TraceRecorder", () => {
	it("正常事件逐行落盘，close 落尽", async () => {
		const dir = await tmpDir();
		const recorder = await TraceRecorder.create(dir, "s1", { flushIntervalMs: 60_000 });
		recorder.record({ type: "agent_start" });
		recorder.record({ type: "turn_start" });
		await recorder.close();
		const lines = await allLines(dir, "s1");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toEqual({ type: "agent_start" });
	});

	it("巨型事件只记截断标记（单行可 parse、带 bytes）", async () => {
		const dir = await tmpDir();
		const recorder = await TraceRecorder.create(dir, "s2", {
			flushIntervalMs: 60_000,
			maxEventBytes: 1024,
		});
		recorder.record({ type: "message_update", huge: "x".repeat(50 * 1024) });
		recorder.record({ type: "turn_start" });
		await recorder.close();
		const lines = await allLines(dir, "s2");
		expect(lines).toHaveLength(2);
		const marker = JSON.parse(lines[0]);
		// type 是合成值 trace_gap（reducer no-op，replay 不崩），真实类型在 originalType
		expect(marker).toMatchObject({ _truncated: true, type: "trace_gap", originalType: "message_update" });
		expect(marker.bytes).toBeGreaterThan(50 * 1024);
		expect(lines[0].length).toBeLessThan(200);
	});

	it("会话进行中按字节轮转（不再只查一次），归档保留最近 5 份", async () => {
		const dir = await tmpDir();
		const sessionId = "s3";
		// rotate=1KB、批次 128 条：持续 record 会跨多次 flush 轮转
		const recorder = await TraceRecorder.create(dir, sessionId, {
			flushIntervalMs: 60_000,
			rotateSizeBytes: 1024,
		});
		for (let i = 0; i < 128 * 12; i++) {
			recorder.record({ type: "tick", i, pad: "y".repeat(32) });
			if (i % 128 === 127) {
				// record 触发的 void flush 是异步的，等它完成再继续
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		await recorder.close();
		const files = (await readdir(join(dir, "traces"))).filter((f) => f.startsWith(`trace-${sessionId}`));
		const archives = files.filter((f) => f !== `trace-${sessionId}.jsonl`);
		expect(archives.length).toBe(5); // MAX_ARCHIVED
		for (const f of files) {
			const { size } = await stat(join(dir, "traces", f));
			// 不变量：单文件 ≤ 轮转阈值 + 单批上限（轮转在整批 append 后触发），远高事故的 12.7GB 无界增长
			expect(size).toBeLessThan(1024 + 128 * 128);
		}
		// 行数：12 批 × 128 条，轮转后 sweep 只留最近 5 份归档 + 活跃文件（旧归档被删，行丢了但文件有界）
		const lines = await allLines(dir, sessionId);
		expect(lines.length).toBeGreaterThanOrEqual(128 * 5);
		expect(JSON.parse(lines[lines.length - 1] ?? "{}")).toMatchObject({ type: "tick", i: 128 * 12 - 1 });
	});

	it("截断标记行可被 reducer 安全消费（replay 含标记行的事故 trace 不崩）", async () => {
		const dir = await tmpDir();
		const recorder = await TraceRecorder.create(dir, "s5", {
			flushIntervalMs: 60_000,
			maxEventBytes: 1024,
		});
		// streaming 活跃期间产生的巨型 message_update 被截断成标记行
		recorder.record({ type: "message_update", huge: "x".repeat(50 * 1024) });
		await recorder.close();
		const [line] = await allLines(dir, "s5");
		const { emptyTranscript, reduceEvent } = await import("@percho/shared");
		const streaming = reduceEvent(emptyTranscript(), { type: "agent_start" } as never);
		// reducer message_update 分支会直接解引用 assistantMessageEvent——标记行必须走 default no-op
		expect(reduceEvent(streaming, JSON.parse(line ?? "{}") as never)).toBe(streaming);
	});

	it("create 时已有超大文件先轮转（按注入限额判定）", async () => {
		const dir = await tmpDir();
		const sessionId = "s6";
		// 预置 2KB 活跃文件：按注入的 1KB 限额应在 create 时轮转为归档
		const traceDir = join(dir, "traces");
		await mkdir(traceDir, { recursive: true });
		await writeFile(join(traceDir, `trace-${sessionId}.jsonl`), "x".repeat(2048));
		const recorder = await TraceRecorder.create(dir, sessionId, {
			flushIntervalMs: 60_000,
			rotateSizeBytes: 1024,
		});
		recorder.record({ type: "agent_start" });
		await recorder.close();
		const files = await readdir(traceDir);
		const archives = files.filter((f) => f !== `trace-${sessionId}.jsonl`);
		expect(archives).toHaveLength(1);
		// 活跃文件是新建的小文件（只含刚 record 的一条）；旧的 2KB 内容完整在归档里
		const active = await readFile(join(traceDir, `trace-${sessionId}.jsonl`), "utf8");
		expect(JSON.parse(active.trim())).toEqual({ type: "agent_start" });
		expect((await readFile(join(traceDir, archives[0] ?? ""), "utf8")).length).toBe(2048);
	});

	it("缓冲字节超限：丢最旧保最新并留标记", async () => {
		const dir = await tmpDir();
		const recorder = await TraceRecorder.create(dir, "s4", {
			flushIntervalMs: 60_000,
			maxBufferBytes: 2048,
		});
		for (let i = 0; i < 100; i++) {
			recorder.record({ type: "tick", i, pad: "z".repeat(100) }); // 每条 ~120B
		}
		await recorder.close();
		const lines = await allLines(dir, "s4");
		const markers = lines.filter((l) => l.includes("buffer_overflow"));
		expect(markers.length).toBeGreaterThanOrEqual(1);
		// 最新事件保留、最旧被丢
		const parsed = lines.map((l) => JSON.parse(l) as { type?: string; i?: number });
		expect(parsed.some((p) => p.i === 99)).toBe(true);
		expect(parsed.some((p) => p.i === 0)).toBe(false);
	});
});
