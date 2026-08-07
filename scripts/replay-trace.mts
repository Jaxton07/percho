// 事件 trace 重放：读会话 trace JSONL → 逐条过 reduceEvent → 输出最终 UI 消息。
// 用于确定性复现 UI 状态问题（与 reduceEvent 单测同源）。
//
// 用法：
//   npx tsx scripts/replay-trace.mts <trace 文件路径>
//   npx tsx scripts/replay-trace.mts --last            # 自动找最新的 trace 文件
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { emptyTranscript, reduceEvent } from "../packages/desktop/src/renderer/src/stores/transcript-reducer.ts";

/** 递归找最新 trace 文件 */
async function findLatestTrace(): Promise<string | null> {
	const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
	let latest: { path: string; mtime: number } | null = null;
	try {
		const projectDirs = await readdir(sessionsRoot);
		for (const dir of projectDirs) {
			const traceDir = join(sessionsRoot, dir, "traces");
			let files: string[];
			try {
				files = await readdir(traceDir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (!file.startsWith("trace-") || !file.endsWith(".jsonl")) continue;
				const path = join(traceDir, file);
				const { mtime } = await stat(path);
				if (!latest || mtime.getTime() > latest.mtime) latest = { path, mtime: mtime.getTime() };
			}
		}
	} catch {
		return null;
	}
	return latest?.path ?? null;
}

async function main() {
	const arg = process.argv[2];
	let tracePath: string | null = arg && arg !== "--last" ? arg : await findLatestTrace();
	if (!tracePath) {
		console.error("未找到 trace 文件。用法：replay-trace.mts <path> 或 --last");
		process.exit(1);
	}

	console.log(`replaying: ${tracePath}\n`);
	const lines = (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
	let state = emptyTranscript();
	let applied = 0;
	let dropped = 0;

	for (const line of lines) {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			dropped++;
			continue;
		}
		const next = reduceEvent(state, event as Parameters<typeof reduceEvent>[1]);
		if (next === state) dropped++;
		state = next;
		applied++;
	}

	console.log(`events: ${lines.length} (applied ${applied}, no-op ${dropped})`);
	console.log(`phase: ${state.phase}  streaming: ${state.streaming ? "active" : "null"}\n`);
	for (const m of state.messages) {
		const tools = m.kind === "assistant" ? m.tools.map((t) => `${t.name}`).join(",") : "";
		console.log(
			`${m.kind.padEnd(9)} thinking=${String("thinking" in m ? m.thinking.length : 0).padStart(4)} text=${String(m.text.length).padStart(4)} tools=${tools}`,
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
