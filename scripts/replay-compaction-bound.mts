// 压缩摘要请求体积 replay harness（spec: .local/agent-work/spec/compaction-bounded.md §1.3；plan 阶段 0）
//
// 用法：npx tsx scripts/replay-compaction-bound.mts <session.jsonl> [选项]
//   --window=1000000       模型窗口（阈值/上限的分母，默认 1000000）
//   --pct=80               触发线百分比（只用于打印，默认 80）
//   --cap-ratio=0.5        摘要输入硬上限比例（默认 0.5）
//   --protect-turns=2      保护区用户轮数（默认 2）
//   --tool-result-chars=300 降级后单条 tool result 文本上限（默认 300）
//   --json                 额外打印机器可读 JSON（给 IMPL-NOTES/对账用）
//
// 口径：用 SDK 自身函数链复现「压缩时真实发出的摘要请求」——
//   SessionManager.getBranch() → prepareCompaction() → compact()（注入捕获用 streamFn）
// 为什么用 streamFn 捕获、而不是自己拼模板：摘要模板（SUMMARIZATION_PROMPT / TURN_PREFIX_SUMMARIZATION_PROMPT）
// 是 SDK 模块内部常量、未导出，手拼只能近似；捕获拿到的 prompt 是逐字节真实的
// （手工证据见 channel/compaction-bounded/evidence/replay-summary-size.mjs，两者应一致）。
//
// 只读纪律：只打开会话文件解析（绝不写入、不改配置、不联网——streamFn 由本脚本提供）。
//
// 阶段定位：脚本里的「层 1 / 层 2」目前是**投影实现**（为了拿到降级后体积的基线数字），
// 阶段 2 换成 `packages/backend/src/tools/compaction-guard/bound.ts` 的真实实现并逐条对账。

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

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
	console.error("用法：npx tsx scripts/replay-compaction-bound.mts <session.jsonl> [--window=…] [--json]");
	process.exit(2);
}
const num = (key: string, fallback: number): number =>
	typeof args[key] === "string" ? Number.parseFloat(args[key] as string) : fallback;
const WINDOW = num("window", 1_000_000);
const THRESHOLD_PCT = num("pct", 80);
const CAP_RATIO = num("cap-ratio", 0.5);
const PROTECT_TURNS = num("protect-turns", 2);
const TOOL_RESULT_CHARS = num("tool-result-chars", 300);
const AS_JSON = args.json === true;

/** 事故会话基线（spec §1.3，手工证据脚本实测）：历史摘要 prompt 字符数。 */
const BASELINE_PROMPT_CHARS = 3_730_260;
/** 该会话当时的 SDK 估算 tokensBefore（spec §1.3）。 */
const BASELINE_TOKENS_BEFORE = 991_721;

// ---------- SDK 内部模块 ----------
// 包 `exports` 不暴露 dist/core/*，只能按包入口推出 dist 目录再绝对路径 import（evidence 脚本同法）。

const SDK_DIST = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const dyn = (rel: string): Promise<any> => import(pathToFileURL(join(SDK_DIST, rel)).href);
const { prepareCompaction, compact } = await dyn("core/compaction/index.js");
const { serializeConversation } = await dyn("core/compaction/utils.js");
const { convertToLlm } = await dyn("core/messages.js");

// ---------- 类型（只描述本脚本走到的形状） ----------

type Block = {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};
type Msg = { role: string; content: string | Block[]; timestamp?: number };

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
	contextWindow: WINDOW,
	maxTokens: 8192,
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

// ---------- 保守估算器（spec D5） ----------
// 与 `context-evaporation/estimate.ts` **故意不同**：那边用估算做排序（相对量可乐观），
// 这边用估算判定上限（绝对量必须保守），系数取实测（中文 0.45–0.5 / ASCII 0.30）之上的安全值。
// 阶段 1 会把它抽成 `tools/compaction-guard/estimate.ts`，本脚本改为 import（避免两处漂移）。

const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uff60]/;
type Counts = { cjk: number; other: number };

function countChars(text: string): Counts {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		if (CJK_RE.test(ch)) cjk++;
		else other++;
	}
	return { cjk, other };
}

const plusCounts = (a: Counts, b: Counts): Counts => ({ cjk: a.cjk + b.cjk, other: a.other + b.other });

/** 纯 ASCII 文本（模板/system 提示）的保守估算：按「其他字符」系数算。 */
const asciiCounts = (chars: number): Counts => ({ cjk: 0, other: chars });

/** spec D5：中文 0.55 / 其他 0.35，再乘安全系数 1.15，向上取整。 */
const tokensFromCounts = (counts: Counts): number => Math.ceil((counts.cjk * 0.55 + counts.other * 0.35) * 1.15);

function estimateTokens(text: string): number {
	return tokensFromCounts(countChars(text));
}

// ---------- 序列化 / 分块统计 ----------

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content as Block[]) {
		if (typeof block?.text === "string") out += block.text;
	}
	return out;
};

/** 一条消息序列化后的字符数（用来在层 2 里逐条量体积）。 */
function serializedChars(message: Msg): number {
	return serializeConversation(convertToLlm([message])).length;
}

/** 一条消息序列化后的**保守估算 tokens**（spec D3 层 2 的比口径）。 */
function serializedEstTokens(message: Msg): number {
	return estimateTokens(serializeConversation(convertToLlm([message])));
}

type Parts = { thinking: number; toolArgs: number; toolResult: number; userText: number; assistantText: number };
const emptyParts = (): Parts => ({ thinking: 0, toolArgs: 0, toolResult: 0, userText: 0, assistantText: 0 });

function addParts(target: Parts, message: Msg): void {
	const content = message.content;
	if (typeof content === "string") {
		if (message.role === "user") target.userText += content.length;
		else target.assistantText += content.length;
		return;
	}
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block.type === "thinking") target.thinking += (block.thinking ?? "").length;
		else if (block.type === "toolCall") target.toolArgs += JSON.stringify(block.arguments ?? {}).length;
		else if (typeof block.text === "string") {
			if (message.role === "toolResult") target.toolResult += block.text.length;
			else if (message.role === "user") target.userText += block.text.length;
			else target.assistantText += block.text.length;
		}
	}
}

// ---------- 保护区 ----------
// 「轮起点」规则同 SDK `isTurnStartMessage`（dist/core/compaction/compaction.js:267，未导出故在此复刻）。

const TURN_START_ROLES = new Set(["user", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

/** 返回保护区起始下标：最近 protectTurns 个用户轮的第一条消息；保护区不足则从 0 起。 */
function protectionStartIndex(messages: Msg[], protectTurns: number): number {
	const starts: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (TURN_START_ROLES.has(messages[i].role)) starts.push(i);
	}
	if (starts.length <= protectTurns) return 0;
	return starts[starts.length - protectTurns];
}

// ---------- 层 1：降级（投影实现，阶段 2 换 bound.ts） ----------

const ARG_WHITELIST = ["path", "file_path", "command", "pattern", "url", "query", "glob", "name", "agent"];
const ARG_VALUE_CHARS = 200;

function degradeArguments(block: Block): { block: Block; shaved: number } {
	const original = JSON.stringify(block.arguments ?? {});
	const kept: Record<string, string> = {};
	for (const key of ARG_WHITELIST) {
		const value = block.arguments?.[key];
		if (typeof value === "string") kept[key] = value.slice(0, ARG_VALUE_CHARS);
		else if (value !== undefined && value !== null) kept[key] = String(value).slice(0, ARG_VALUE_CHARS);
	}
	const omitted = original.length - JSON.stringify(kept).length;
	const next: Block = {
		...block,
		arguments: { ...kept, _omitted: `…（已省略 ${omitted} 字符）` },
	};
	return { block: next, shaved: original.length - JSON.stringify(next.arguments).length };
}

function degradeToolResultText(text: string, maxChars: number): { text: string; shaved: number } {
	if (text.length <= maxChars) return { text, shaved: 0 };
	const lines = text.split("\n");
	const head = lines.slice(0, 5).join("\n");
	const tail = lines.slice(-3).join("\n");
	let next = `${head}\n…\n${tail}`;
	if (next.length > maxChars) next = `${next.slice(0, maxChars)}…[后续 ${text.length - maxChars} 字符已省略]`;
	return { text: next, shaved: text.length - next.length };
}

type Layer1Result = { messages: Msg[]; changed: number; parts: Parts };

function layer1Degrade(messages: Msg[], protectTurns: number, toolResultChars: number): Layer1Result {
	const protectFrom = protectionStartIndex(messages, protectTurns);
	const stats = emptyParts();
	let changed = 0;
	const out = messages.map((message, index) => {
		if (index >= protectFrom) return message;
		const content = message.content;
		if (!Array.isArray(content)) return message;
		let mutated = false;
		const blocks = content.map((block) => {
			if (block.type === "thinking" && (block.thinking ?? "").length > 0) {
				const placeholder = `[思考已省略 ${block.thinking?.length ?? 0} 字符]`;
				stats.thinking += (block.thinking?.length ?? 0) - placeholder.length;
				mutated = true;
				return { ...block, thinking: placeholder };
			}
			if (block.type === "toolCall") {
				const { block: next, shaved } = degradeArguments(block);
				if (shaved > 0) {
					stats.toolArgs += shaved;
					mutated = true;
				}
				return next;
			}
			if (message.role === "toolResult" && typeof block.text === "string") {
				const { text, shaved } = degradeToolResultText(block.text, toolResultChars);
				if (shaved > 0) {
					stats.toolResult += shaved;
					mutated = true;
					return { ...block, text };
				}
			}
			return block;
		});
		if (!mutated) return message;
		changed++;
		return { ...message, content: blocks };
	});
	return { messages: out, changed, parts: stats };
}

// ---------- 层 2：硬上限（投影实现，阶段 2 换 bound.ts） ----------

type Layer2Result = { messages: Msg[]; dropped: number; insertedMarkerChars: number; oversized: number };

function layer2Cap(messages: Msg[], cap: number): Layer2Result {
	const sizes = messages.map(serializedEstTokens);
	let total = sizes.reduce((a, b) => a + b, 0);
	let start = 0;
	let dropped = 0;
	while (start < messages.length && total > cap) {
		total -= sizes[start];
		start++;
		dropped++;
	}
	const marker = dropped > 0 ? `[更早的 ${dropped} 条消息已省略]` : "";
	const markerChars = marker ? serializedChars({ role: "user", content: [{ type: "text", text: marker }] }) : 0;
	const oversized = messages.filter((_, i) => sizes[i] > cap).length;
	return { messages: messages.slice(start), dropped, insertedMarkerChars: markerChars, oversized };
}

// ---------- 测量 ----------

type RequestMeasure = {
	label: string;
	systemChars: number;
	promptChars: number;
	conversationChars: number;
	overheadChars: number;
	estTokens: number;
	parts: Parts;
	partsDegradable: Parts;
	partsProtected: Parts;
};

function measureRequest(label: string, captured: CapturedRequest, messages: Msg[]): RequestMeasure {
	let systemChars = 0;
	let promptChars = 0;
	let counts: Counts = { cjk: 0, other: 0 };
	for (const message of captured.messages) {
		const text = textOf(message.content);
		if (message.role === "system") systemChars += text.length;
		else promptChars += text.length;
		counts = plusCounts(counts, countChars(text));
	}
	const conversationChars = serializeConversation(convertToLlm(messages)).length;
	const all = emptyParts();
	const degradable = emptyParts();
	const protectedParts = emptyParts();
	const protectFrom = protectionStartIndex(messages, PROTECT_TURNS);
	for (let i = 0; i < messages.length; i++) {
		addParts(all, messages[i]);
		addParts(i >= protectFrom ? protectedParts : degradable, messages[i]);
	}
	return {
		label,
		systemChars,
		promptChars,
		conversationChars,
		overheadChars: promptChars - conversationChars,
		estTokens: tokensFromCounts(counts),
		parts: all,
		partsDegradable: degradable,
		partsProtected: protectedParts,
	};
}

async function main(): Promise<void> {
	const session = SessionManager.open(SESSION_FILE);
	const entries = session.getBranch();
	const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
	const prep = prepareCompaction(entries, settings);
	if (!prep) {
		console.log("prepareCompaction → undefined（无需压缩：会话太小或末尾已是 compaction）");
		return;
	}

	// 捕获真实摘要请求：compact() 内部按 split turn 决定发 1 次还是 2 次（历史 / turn prefix）。
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

	const historyMsgs = (prep.messagesToSummarize ?? []) as Msg[];
	const prefixMsgs = (prep.turnPrefixMessages ?? []) as Msg[];
	const measures: RequestMeasure[] = calls.map((call, index) => {
		const isPrefix = prep.isSplitTurn && index === calls.length - 1;
		return measureRequest(isPrefix ? "turn-prefix" : "history", call, isPrefix ? prefixMsgs : historyMsgs);
	});

	const cap = Math.max(Math.min(CAP_RATIO * WINDOW, prep.tokensBefore), 65536);

	// 层 1 / 层 2 投影（对每个请求各跑一遍，与 spec D3 一致）
	const projections = measures.map((measure) => {
		const source = measure.label === "turn-prefix" ? prefixMsgs : historyMsgs;
		const degraded = layer1Degrade(source, PROTECT_TURNS, TOOL_RESULT_CHARS);
		const degradedChars = serializeConversation(convertToLlm(degraded.messages)).length;
		const capped = layer2Cap(degraded.messages, cap);
		const cappedText = serializeConversation(convertToLlm(capped.messages));
		const afterChars = cappedText.length + capped.insertedMarkerChars;
		const promptChars = afterChars + measure.overheadChars;
		// 投影后的保守估算 = 降级正文（真实文本）+ 模板/system（英文，按其他字符系数）
		const afterCounts = plusCounts(countChars(cappedText), asciiCounts(measure.overheadChars + measure.systemChars));
		const estTokens = tokensFromCounts(afterCounts);
		const postParts = emptyParts();
		for (const message of capped.messages) addParts(postParts, message);
		return {
			label: measure.label,
			sourceMessages: source.length,
			degradedMessages: degraded.changed,
			shavedChars: degraded.parts.thinking + degraded.parts.toolArgs + degraded.parts.toolResult,
			degradedChars,
			projectedPromptChars: promptChars,
			projectedEstTokens: estTokens,
			droppedMessages: capped.dropped,
			oversizedMessages: capped.oversized,
			postParts,
			capReachable: estTokens <= cap,
		};
	});

	const rawPromptChars = measures.reduce((sum, m) => sum + m.promptChars, 0);
	const rawEstTokens = measures.reduce((sum, m) => sum + m.estTokens, 0);
	const history = measures.find((m) => m.label === "history");
	const projectedPromptChars = projections.reduce((sum, p) => sum + p.projectedPromptChars, 0);
	const projectedEstTokens = projections.reduce((sum, p) => sum + p.projectedEstTokens, 0);
	const capReachable = projections.every((p) => p.capReachable);

	// ---------- 报告 ----------
	const pad = (label: string): string => `${label}：`;
	console.log(`会话文件：${SESSION_FILE}`);
	console.log(`branch entries：${entries.length} · tokensBefore(SDK 估算)：${prep.tokensBefore}`);
	console.log(
		`messagesToSummarize：${historyMsgs.length} · isSplitTurn：${prep.isSplitTurn} · turnPrefixMessages：${prefixMsgs.length} · 摘要请求次数：${calls.length}`,
	);
	console.log("");
	console.log("【原始（未降级）摘要请求】");
	for (const m of measures) {
		console.log(
			`  ${pad(m.label)}prompt ${m.promptChars} 字符（会话正文 ${m.conversationChars} + 模板/包裹 ${m.overheadChars}）· system ${m.systemChars} · 保守估算 ${m.estTokens} tokens`,
		);
		const p = m.parts;
		console.log(
			`    分块（原始 block 字符；序列化会重排 toolCall 参数、对 toolResult 截 2000 字符，故与上一行正文数不等）：思考 ${p.thinking} · toolCall 参数 ${p.toolArgs} · toolResult ${p.toolResult} · user ${p.userText} · assistant 正文 ${p.assistantText}`,
		);
		console.log(
			`    其中可降级（保护区外）：思考 ${m.partsDegradable.thinking} · 参数 ${m.partsDegradable.toolArgs} · toolResult ${m.partsDegradable.toolResult}；保护区内：思考 ${m.partsProtected.thinking} · 参数 ${m.partsProtected.toolArgs} · toolResult ${m.partsProtected.toolResult}`,
		);
	}
	console.log(
		`  合计：prompt ${rawPromptChars} 字符 · 保守估算 ${rawEstTokens} tokens（触发线 ${THRESHOLD_PCT}% = ${Math.round((WINDOW * THRESHOLD_PCT) / 100)} tokens，SDK 触发线 ${WINDOW - settings.reserveTokens}）`,
	);
	console.log("");
	console.log(`【层 1+2 投影】cap = ${cap} tokens（${CAP_RATIO}×${WINDOW}，下限 65536）`);
	for (const p of projections) {
		console.log(
			`  ${pad(p.label)}降级 ${p.degradedMessages}/${p.sourceMessages} 条 · 省 ${p.shavedChars} 字符 → ${p.degradedChars} 字符；丢 ${p.droppedMessages} 条最旧消息（单条超 cap ${p.oversizedMessages} 条）→ 投影 prompt ${p.projectedPromptChars} 字符 ≈ ${p.projectedEstTokens} tokens · cap 可达 ${p.capReachable ? "是" : "否"}`,
		);
		const q = p.postParts;
		console.log(
			`    降级后分块（字符）：思考 ${q.thinking} · 参数 ${q.toolArgs} · toolResult ${q.toolResult} · user ${q.userText} · assistant 正文 ${q.assistantText}`,
		);
	}
	console.log(
		`  合计投影 prompt ${projectedPromptChars} 字符（原始 ${rawPromptChars}，降到 ${((projectedPromptChars / rawPromptChars) * 100).toFixed(1)}%）· 保守估算 ${projectedEstTokens} tokens（原始 ${rawEstTokens}，降到 ${((projectedEstTokens / rawEstTokens) * 100).toFixed(1)}%）· cap 全部可达：${capReachable ? "是" : "否"}`,
	);
	console.log("");
	if (history) {
		const delta = history.promptChars - BASELINE_PROMPT_CHARS;
		console.log("【事故会话基线复核（spec §1.3）】");
		console.log(
			`  历史 prompt ${history.promptChars} 字符 vs 基线 ${BASELINE_PROMPT_CHARS}（差 ${delta >= 0 ? "+" : ""}${delta}，${((delta / BASELINE_PROMPT_CHARS) * 100).toFixed(3)}%，容差 ±1%）→ ${Math.abs(delta / BASELINE_PROMPT_CHARS) <= 0.01 ? "复现通过" : "不一致"}`,
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
					messagesToSummarize: historyMsgs.length,
					turnPrefixMessages: prefixMsgs.length,
					window: WINDOW,
					cap,
					rawPromptChars,
					rawEstTokens,
					projectedPromptChars,
					capReachable,
					measures,
					projections,
				},
				null,
				1,
			),
		);
	}
}

await main();
