// 压缩摘要请求体积 replay harness（spec: .local/agent-work/spec/compaction-bounded.md §1.3 / §6 A3；
// plan 阶段 2 第 4 条：**删掉内置投影，改 import 真实 bound.ts**，单一事实源）
//
// 用法：npx tsx scripts/replay-compaction-bound.mts <session.jsonl> [选项]
//   --window=1000000        模型窗口（可给多档，逗号分隔：1000000,200000）
//   --pct=80                触发线百分比（只用于打印）
//   --cap-ratio=0.5         摘要输入硬上限比例
//   --protect-turns=2       保护区用户轮数
//   --tool-result-chars=300 降级后单条 tool result 文本上限
//   --json                  额外打印机器可读 JSON
//
// 口径：用 SDK 自身函数链复现「压缩时真实发出的摘要请求」——
//   SessionManager.getBranch() → prepareCompaction() → compact()（注入捕获用 streamFn）
// 捕获到的 prompt 就是失败时真发的那份（摘要模板是 SDK 内部常量、未导出，手拼只能近似）。
// 然后**把同一份 messages 喂给线上同一个 `boundMessages()`**，量有界化后的体积。
//
// 只读纪律：只打开会话文件解析（不写入、不改配置、不联网——streamFn 由本脚本提供）。

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { boundMessages, exactEstimate } from "../packages/backend/src/tools/compaction-guard/bound";
import { estimateTokens } from "../packages/backend/src/tools/compaction-guard/estimate";
import { hardCapTokens } from "../packages/backend/src/tools/compaction-guard/guard";
import type { CompactionBoundStats, GuardMessage } from "../packages/backend/src/tools/compaction-guard/types";

// ---------- 参数 ----------

function parseArgs(): Record<string, string | boolean | undefined> {
	const out: Record<string, string | boolean | undefined> = {};
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (!a.startsWith("--")) continue; // argv[2] 是会话文件路径
		const eq = a.indexOf("=");
		if (eq > 0) {
			out[a.slice(2, eq)] = a.slice(eq + 1);
			continue;
		}
		const v = process.argv[i + 1];
		if (v === undefined || v.startsWith("--")) out[a.slice(2)] = true;
		else {
			out[a.slice(2)] = v;
			i++;
		}
	}
	return out;
}

const args = parseArgs();
const SESSION_FILE = process.argv[2];
if (!SESSION_FILE || SESSION_FILE.startsWith("--")) {
	console.error("用法：npx tsx scripts/replay-compaction-bound.mts <session.jsonl> [--window=1000000,200000] [--json]");
	process.exit(2);
}
const num = (key: string, fallback: number): number =>
	typeof args[key] === "string" ? Number.parseFloat(args[key] as string) : fallback;
const WINDOWS = (typeof args.window === "string" ? args.window : "1000000")
	.split(",")
	.map((value) => Number.parseFloat(value.trim()))
	.filter((value) => Number.isFinite(value) && value > 0);
const THRESHOLD_PCT = num("pct", 80);
const CAP_RATIO = num("cap-ratio", 0.5);
const PROTECT_TURNS = num("protect-turns", 2);
const TOOL_RESULT_CHARS = num("tool-result-chars", 300);
const RESERVE_TOKENS = num("reserve-tokens", 16_384);
const MAX_TOKENS = num("max-tokens", 32_000);
const AS_JSON = args.json === true;

/** 事故会话基线（spec §1.3，手工证据脚本实测）：历史摘要 prompt 字符数。 */
const BASELINE_PROMPT_CHARS = 3_730_260;
/** 该会话当时的 SDK 估算 tokensBefore（spec §1.3）。 */
const BASELINE_TOKENS_BEFORE = 991_721;
/** 提供商实测上限（spec §1.3）：A3 要求断言 ≤ 它的 50%。 */
const PROVIDER_LIMIT_TOKENS = 994_387;

// ---------- SDK 内部模块 ----------
// 包 `exports` 不暴露 dist/core/*，只能按包入口推出 dist 目录再绝对路径 import。

const SDK_DIST = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const dyn = (rel: string): Promise<any> => import(pathToFileURL(join(SDK_DIST, rel)).href);
const { prepareCompaction, compact } = await dyn("core/compaction/index.js");
const { serializeConversation } = await dyn("core/compaction/utils.js");
const { convertToLlm } = await dyn("core/messages.js");

/** 线上同一份序列化器（SDK 同源）：convertToLlm → serializeConversation */
const serialize = (messages: GuardMessage[]): string => serializeConversation(convertToLlm(messages));

type CapturedRequest = { messages: { role: string; content: unknown }[] };

const USAGE = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MODEL = {
	id: "replay-compaction-bound",
	name: "replay-compaction-bound",
	api: "openai-completions",
	provider: "offline",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: {},
	contextWindow: WINDOWS[0] ?? 1_000_000,
	maxTokens: MAX_TOKENS,
};

/** 捕获用 streamFn：记下请求原文，回一个假摘要（不联网、不发请求）。 */
function makeCaptureStreamFn(calls: CapturedRequest[]) {
	return async (_model: unknown, context: CapturedRequest) => {
		calls.push(structuredClone(context));
		return {
			result: async () => ({ stopReason: "success", content: [{ type: "text", text: "摘要" }], usage: USAGE }),
		};
	};
}

// ---------- 小工具 ----------

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content as { text?: string }[]) {
		if (typeof block?.text === "string") out += block.text;
	}
	return out;
};

const pad = (label: string, width: number): string => label.padEnd(width, " ");

// ---------- 主流程 ----------

const session = SessionManager.open(SESSION_FILE);
const entries = session.getBranch();
const settings = { enabled: true, reserveTokens: RESERVE_TOKENS, keepRecentTokens: 20_000 };
const prep = prepareCompaction(entries, settings);
if (!prep) {
	console.log("prepareCompaction → undefined（无需压缩：会话太小或末尾已是 compaction）");
	process.exit(0);
}

// 捕获真实摘要请求：compact() 内部按 split turn 决定发 1 次还是 2 次（历史 / turn prefix）
const calls: CapturedRequest[] = [];
await compact(
	prep,
	MODEL,
	"offline-replay-key",
	{},
	undefined,
	new AbortController().signal,
	"off",
	makeCaptureStreamFn(calls),
	{},
	{ enabled: false },
	undefined,
	undefined,
);

const historyMessages = (prep.messagesToSummarize ?? []) as unknown as GuardMessage[];
const prefixMessages = (prep.turnPrefixMessages ?? []) as unknown as GuardMessage[];

interface RawMeasure {
	label: string;
	promptChars: number;
	conversationChars: number;
	overheadChars: number;
	estTokens: number;
	messages: number;
}

const rawMeasures: RawMeasure[] = calls.map((call, index) => {
	const isPrefix = prep.isSplitTurn && index === calls.length - 1;
	const messages = isPrefix ? prefixMessages : historyMessages;
	let promptChars = 0;
	for (const message of call.messages) {
		if (message.role === "system") continue;
		promptChars += textOf(message.content).length;
	}
	const conversationChars = serialize(messages).length;
	const promptText = call.messages
		.filter((m) => m.role !== "system")
		.map((m) => textOf(m.content))
		.join("");
	return {
		label: isPrefix ? "turn-prefix" : "history",
		promptChars,
		conversationChars,
		overheadChars: promptChars - conversationChars,
		estTokens: estimateTokens(promptText),
		messages: messages.length,
	};
});

const rawHistory = rawMeasures.find((m) => m.label === "history");
const rawTotalEst = rawMeasures.reduce((sum, m) => sum + m.estTokens, 0);

interface BoundMeasure {
	window: number;
	cap: number;
	activate: boolean;
	history: CompactionBoundStats;
	prefix?: CompactionBoundStats;
	historyExact: number;
	prefixExact: number;
	totalExact: number;
	withinCap: boolean;
	promptCharsAfter: number;
}

const bounds: BoundMeasure[] = WINDOWS.map((contextWindow) => {
	const cap = hardCapTokens({
		contextWindow,
		reserveTokens: RESERVE_TOKENS,
		maxTokens: MAX_TOKENS,
		hardCapRatio: CAP_RATIO,
	});
	const options = { cap, protectTurns: PROTECT_TURNS, toolResultChars: TOOL_RESULT_CHARS, serialize };
	const history = boundMessages(historyMessages, options);
	const prefix = prefixMessages.length > 0 ? boundMessages(prefixMessages, options) : undefined;
	const historyExact = exactEstimate(history.messages, serialize);
	const prefixExact = prefix ? exactEstimate(prefix.messages, serialize) : 0;
	return {
		window: contextWindow,
		cap,
		activate: Number.isFinite(cap) && cap > 0,
		history: history.stats,
		prefix: prefix?.stats,
		historyExact,
		prefixExact,
		totalExact: historyExact + prefixExact,
		withinCap: history.stats.withinCap && (prefix?.stats.withinCap ?? true),
		promptCharsAfter: serialize(history.messages).length + (prefix ? serialize(prefix.messages).length : 0),
	};
});

// ---------- 报告 ----------

console.log(`会话文件：${SESSION_FILE}`);
console.log(`branch entries：${entries.length} · tokensBefore(SDK 估算)：${prep.tokensBefore}`);
console.log(
	`messagesToSummarize：${historyMessages.length} · isSplitTurn：${prep.isSplitTurn} · turnPrefixMessages：${prefixMessages.length} · 摘要请求次数：${calls.length}`,
);
console.log("");
console.log("【原始（未降级）摘要请求】");
for (const m of rawMeasures) {
	console.log(
		`  ${pad(m.label, 12)} prompt ${m.promptChars} 字符（会话正文 ${m.conversationChars} + 模板/包裹 ${m.overheadChars}）· 保守估算 ${m.estTokens} tokens · ${m.messages} 条`,
	);
}
console.log(
	`  合计：保守估算 ${rawTotalEst} tokens（触发线 ${THRESHOLD_PCT}% = ${Math.round(((WINDOWS[0] ?? 1_000_000) * THRESHOLD_PCT) / 100)} tokens）`,
);
console.log("");
console.log("【线上 bound.ts 有界化后】（同一份实现，非本脚本复刻）");
for (const b of bounds) {
	console.log(
		`  窗口 ${b.window} · cap ${b.cap} tokens${b.activate ? "" : "（≤0 ⇒ 不介入）"}`,
	);
	console.log(
		`    history：降级 ${b.history.degradedMessages}/${b.history.messageCount} 条 · 丢 ${b.history.droppedMessages} 条 · 口径 ${b.history.measure}（迭代 ${b.history.capRounds} 轮）· 估算 ${b.history.estimatedBefore} → ${b.history.estimatedAfter}（整体实测 ${b.historyExact}）`,
	);
	if (b.prefix) {
		console.log(
			`    turn-prefix：降级 ${b.prefix.degradedMessages}/${b.prefix.messageCount} 条 · 丢 ${b.prefix.droppedMessages} 条 · 估算 ${b.prefix.estimatedBefore} → ${b.prefix.estimatedAfter}（整体实测 ${b.prefixExact}）`,
		);
	}
	console.log(
		`    整体实测合计 ${b.totalExact} tokens · ≤ cap ${b.withinCap ? "是" : "否"}${b.activate ? "" : "（未介入）"} · prompt 字符 ${b.promptCharsAfter}（原始 ${rawMeasures.reduce((s, m) => s + m.conversationChars, 0)}，降到 ${(((b.promptCharsAfter / Math.max(1, rawMeasures.reduce((s, m) => s + m.conversationChars, 0))) * 100)).toFixed(1)}%）`,
	);
	console.log(
		`    A3 断言：整体实测 ≤ cap ${b.totalExact <= b.cap || !b.activate ? "✓" : "✗"} · ≤ 提供商上限 50%（${Math.round(PROVIDER_LIMIT_TOKENS * 0.5)}）${b.totalExact <= PROVIDER_LIMIT_TOKENS * 0.5 ? "✓" : "✗"}`,
	);
}
console.log("");
if (rawHistory) {
	const delta = rawHistory.promptChars - BASELINE_PROMPT_CHARS;
	console.log("【事故会话基线复核（spec §1.3）】");
	console.log(
		`  历史 prompt ${rawHistory.promptChars} 字符 vs 基线 ${BASELINE_PROMPT_CHARS}（差 ${delta >= 0 ? "+" : ""}${delta}，${((delta / BASELINE_PROMPT_CHARS) * 100).toFixed(3)}%，容差 ±1%）→ ${Math.abs(delta / BASELINE_PROMPT_CHARS) <= 0.01 ? "复现通过" : "不一致"}`,
	);
	console.log(
		`  tokensBefore ${prep.tokensBefore} vs 基线 ${BASELINE_TOKENS_BEFORE} → ${prep.tokensBefore === BASELINE_TOKENS_BEFORE ? "一致" : "不一致"}`,
	);
}

if (AS_JSON) {
	console.log("");
	console.log("【JSON】");
	console.log(
		JSON.stringify(
			{
				sessionFile: SESSION_FILE,
				entries: entries.length,
				tokensBefore: prep.tokensBefore,
				isSplitTurn: prep.isSplitTurn,
				messagesToSummarize: historyMessages.length,
				turnPrefixMessages: prefixMessages.length,
				rawEstTokens: rawTotalEst,
				rawPromptChars: rawMeasures.map((m) => m.promptChars),
				bounds,
			},
			null,
			1,
		),
	);
}
