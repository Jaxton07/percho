// 上下文蒸发 replay 调参脚本（spec: .local/agent-work/spec/context-evaporation.md §13）
//
// 用法：npx tsx scripts/replay-evaporation.mts [--data <dir>] [--out <dir>] [--configs grid|<逗号名单>]
//       [--only <文件名子串>] [--limit N] [--debug] [--core]
// 数据默认指向 .local/replay-data/sessions（副本），绝不读写正式 ~/.pi/agent/sessions。
// --core：mono 变体改用 packages/backend/src/tools/context-evaporation/ 的蒸发核心
// （evaporateWire + inspectParts）驱动模拟——离线/在线同构验证（arch §9），
// 与既有基准逐字节比对。runner 侧对 wire 做基线同口径预处理：剥 ACP 标签、
// 丢弃 toolResult 图片 block（基线 Part 模型不计，核心本身支持图片蒸发）。
//
// 模拟口径（与 spec §3-§7 对齐，细节见 .local/agent-work/handoff/evap-replay-results.md 附录）：
// - step = 主链上每条 assistant 消息（该消息产生前的 wire = 主链上之前的全部消息）
// - token 估算：CJK×1.7 + 非CJK/4（无 API，跨配置可比即可）
// - cache 模型：token 偏移前缀——每 step 找 wire 第一个状态变化 part，cacheRead = 其前 token 数
// - monotonic-bigjump：决策持久化（state 数组即决策），水位跨线批量蒸发（hysteresis 5%），状态只升不降
// - naive-sliding：无决策记忆，gate 用上一步实际发送量（复现文章 $77 形态：全量 stub↔full 振荡）

import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	evaporateWire,
	inspectParts,
} from "../packages/backend/src/tools/context-evaporation/evaporate.ts";
import {
	createEvapState,
	type EvapConfig,
	type EvapWireMessage,
} from "../packages/backend/src/tools/context-evaporation/types.ts";

// ---------- CLI ----------

function parseArgs(): Record<string, string | boolean | undefined> {
	const out: Record<string, string | boolean | undefined> = {};
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a.startsWith("--")) {
			const v = process.argv[i + 1];
			if (v === undefined || v.startsWith("--")) out[a.slice(2)] = true;
			else {
				out[a.slice(2)] = v;
				i++;
			}
		}
	}
	return out;
}

const args = parseArgs();
const DATA_DIR = typeof args.data === "string" ? args.data : ".local/replay-data/sessions";
const OUT_DIR = typeof args.out === "string" ? args.out : ".local/replay-data/out";
const ONLY = typeof args.only === "string" ? args.only : undefined;
const LIMIT = typeof args.limit === "string" ? Number.parseInt(args.limit, 10) : undefined;
const DEBUG = args.debug === true;
const CORE = args.core === true;
const CONFIGS = typeof args.configs === "string" ? args.configs : "grid";

// ---------- 常量 ----------

const ACP_TAG_RE = /<acp\s[^>]*>m\d{1,5}<\/acp>/g;
const MARKER_TOKENS = 30; // "[输出已淘汰：…]" 类标记行
const EXTERNAL_MARKER_TOKENS = 40;
const IMAGE_STUB_TOKENS = 25;
const IMAGE_FULL_TOKENS = 1000; // 估算常量：一张图 ≈ 1K token
const FOLD_BLOCK_MIN_BYTES = 512; // 用户贴的代码块折叠阈值
const HEAD_TAIL_THRESHOLD = 4096; // spec headTailThreshold
const HYSTERESIS_PCT = 5; // Tier 内 hysteresis 缓冲（spec §4-3）
const MIS_KILL_USER_TURNS = 3; // 误杀口径：3 个 user 轮内（handoff）
const MIS_KILL_STEPS = 20; // 补充口径：user 轮稀疏时的步数窗口

const READ_HEAD = 10;
const READ_TAIL = 5;
const CMD_HEAD = 15;
const CMD_TAIL = 25;
const STUB_TAIL = 5;

// ---------- token 估算 ----------

/** CJK 区段判断（含谚文/假名注音/全角等，粗粒度够用） */
function isCJKCode(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x11ff) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xa960 && cp <= 0xa97f) ||
		(cp >= 0xac00 && cp <= 0xd7ff) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xfffd)
	);
}

function estTokens(s: string): number {
	if (!s) return 0;
	let cjk = 0;
	for (let i = 0; i < s.length; i++) {
		if (isCJKCode(s.charCodeAt(i))) cjk++;
	}
	return Math.ceil(cjk * 1.7 + (s.length - cjk) / 4);
}

function stripAcp(text: string): string {
	return text.replace(ACP_TAG_RE, "");
}

// ---------- 数据模型 ----------

type EvapClass =
	| "userText"
	| "image"
	| "assistantText"
	| "toolCall"
	| "read"
	| "command"
	| "external"
	| "editWrite"
	| "protected";

type PartState = "full" | "fold" | "snip" | "stub" | "trim";

interface Part {
	cls: EvapClass;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	callPaths?: string[]; // 产生该结果的 toolCall 参数里提取的文件路径（误杀分析用）
	text?: string; // 原文（toolResult / assistantText；已剥 ACP 标签）
	tFull: number;
	tSnip: number; // 不适用时 = tFull
	tStub: number; // 不适用时 = tFull
	tFold: number; // 不适用时 = tFull
	tTrim: number; // 不适用时 = tFull
	stubbable: boolean; // Tier 2 可 stub 的类（运行时再按 t2scope/bytes 细判）
	bytes: number;
}

interface CallRec {
	stepIdx: number;
	userTurnIdx: number;
	toolName: string;
	paths: string[];
}

interface ChainSession {
	file: string;
	chain: Entry[];
	parts: Part[];
	stepAtPart: number[]; // part 被追加时已完成的 step 数；step k 的 wire = stepAtPart ≤ k 的 parts
	userTurnAtPart: number[];
	steps: number;
	userTurns: number;
	calls: CallRec[];
	hasCompaction: boolean;
	hasAcp: boolean;
}

// ---------- jsonl 加载 + 主链重建 ----------

interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
	message?: any;
}

function loadEntries(file: string): Entry[] {
	const out: Entry[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const l = line.trim();
		if (!l) continue;
		try {
			out.push(JSON.parse(l));
		} catch {
			// 损坏行跳过
		}
	}
	return out;
}

function mainChain(entries: Entry[]): Entry[] {
	const byId = new Map<string, Entry>();
	let last: Entry | undefined;
	for (const e of entries) {
		if (e.id) byId.set(e.id, e);
		last = e;
	}
	const chain: Entry[] = [];
	const seen = new Set<string>();
	let cur: Entry | undefined = last;
	while (cur && cur.id && !seen.has(cur.id)) {
		seen.add(cur.id);
		chain.push(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	chain.reverse();
	return chain;
}

/** 从 bash 命令串提取疑似文件路径（含 '/' 的非 flag token，排除 URL） */
function extractPathsFromCommand(cmd: string): string[] {
	const paths = new Set<string>();
	for (const raw of cmd.split(/\s+/)) {
		const t = raw.replace(/^["']+|["',;:]+$/g, "");
		if (!t || t.startsWith("-") || t.includes("://") || t.length < 3) continue;
		if (!t.includes("/")) continue;
		if (/^[A-Za-z0-9_-]+$/.test(t)) continue; // 无路径分隔的纯命令名
		paths.add(t.replace(/\/+$/, ""));
	}
	return [...paths];
}

function extractPathsFromCall(toolName: string, callArgs: any): string[] {
	try {
		if (toolName === "read" && typeof callArgs?.path === "string") {
			return [callArgs.path.replace(/\/+$/, "")];
		}
		if (toolName === "bash" && typeof callArgs?.command === "string") {
			return extractPathsFromCommand(callArgs.command);
		}
	} catch {
		// ignore
	}
	return [];
}

function classifyTool(toolName: string | undefined): EvapClass {
	switch (toolName) {
		case "read":
			return "read";
		case "webfetch":
		case "mcp":
		case "mcpScript":
		case "search_pi_packages":
			return "external";
		case "edit":
		case "write":
			return "editWrite";
		case "todo":
			return "protected";
		default:
			return "command"; // bash / ls / find / subagent / 其余
	}
}

/** 头尾截断 token；太短不值得截断返回 -1 */
function headTailTokens(lines: string[], head: number, tail: number): number {
	if (lines.length <= head + tail + 2) return -1;
	return (
		estTokens(lines.slice(0, head).join("\n")) + estTokens(lines.slice(-tail).join("\n")) + MARKER_TOKENS
	);
}

/** 用户文本：代码块折叠 token（块外原文 + 大块头 5 行 + 标注）；无可折叠大块返回 -1 */
function foldUserText(text: string): number {
	const parts = text.split(/```/);
	if (parts.length < 3) return -1;
	let hasBigBlock = false;
	let total = 0;
	for (let i = 0; i < parts.length; i++) {
		if (i % 2 === 0) {
			total += estTokens(parts[i]);
			continue;
		}
		const lines = parts[i].split("\n");
		if (parts[i].length >= FOLD_BLOCK_MIN_BYTES && lines.length > 7) {
			hasBigBlock = true;
			total += estTokens(lines.slice(0, 5).join("\n")) + MARKER_TOKENS;
		} else {
			total += estTokens(parts[i]);
		}
	}
	return hasBigBlock ? total : -1;
}

/** assistant 文本：留前两句 + 标记（§15.4 探针用） */
function trimAssistantTokens(text: string): number {
	const sents = text.split(/(?<=[。！？.!?\n])/);
	return estTokens(sents.slice(0, 2).join("")) + MARKER_TOKENS;
}

function loadSession(file: string): ChainSession {
	const entries = loadEntries(file);
	const chain = mainChain(entries);
	const parts: Part[] = [];
	const stepAtPart: number[] = [];
	const userTurnAtPart: number[] = [];
	const calls: CallRec[] = [];
	let steps = 0;
	let userTurns = 0;
	let hasCompaction = false;
	let hasAcp = false;
	const callPathById = new Map<string, { toolName: string; paths: string[] }>();

	const pushPart = (p: Part) => {
		stepAtPart.push(steps);
		userTurnAtPart.push(userTurns);
		parts.push(p);
	};

	for (const e of chain) {
		if (e.type === "compaction") hasCompaction = true;
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		const role = m.role;
		if (role === "user") {
			userTurns++;
			const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
			for (const b of content) {
				if (b.type === "text") {
					const text = stripAcp(String(b.text ?? ""));
					if (/<acp\s/.test(text)) hasAcp = true;
					const tFull = estTokens(text);
					const tFold = foldUserText(text);
					pushPart({
						cls: "userText",
						text,
						tFull,
						tSnip: tFull,
						tStub: tFull,
						tFold: tFold < 0 ? tFull : tFold,
						tTrim: tFull,
						stubbable: false,
						bytes: text.length,
					});
				} else if (b.type === "image") {
					pushPart({
						cls: "image",
						tFull: IMAGE_FULL_TOKENS,
						tSnip: IMAGE_FULL_TOKENS,
						tStub: IMAGE_STUB_TOKENS,
						tFold: IMAGE_FULL_TOKENS,
						tTrim: IMAGE_FULL_TOKENS,
						stubbable: true,
						bytes: 0,
					});
				}
			}
		} else if (role === "assistant") {
			steps++; // step 点：这条消息产生前 wire = 之前的全部 parts
			const content = m.content || [];
			for (const b of content) {
				if (b.type === "thinking") continue; // wire 不回传 thinking
				if (b.type === "text") {
					const text = stripAcp(String(b.text ?? ""));
					if (/<acp\s/.test(text)) hasAcp = true;
					const tFull = estTokens(text);
					pushPart({
						cls: "assistantText",
						text,
						tFull,
						tSnip: tFull,
						tStub: tFull,
						tFold: tFull,
						tTrim: text.length > 400 ? trimAssistantTokens(text) : tFull,
						stubbable: false,
						bytes: text.length,
					});
				} else if (b.type === "toolCall") {
					const argsJson = JSON.stringify(b.arguments ?? {});
					const paths = extractPathsFromCall(b.name, b.arguments);
					callPathById.set(b.id, { toolName: b.name, paths });
					calls.push({ stepIdx: steps - 1, userTurnIdx: userTurns, toolName: b.name, paths });
					pushPart({
						cls: "toolCall",
						toolName: b.name,
						tFull: estTokens(argsJson) + MARKER_TOKENS,
						tSnip: 0,
						tStub: 0,
						tFold: 0,
						tTrim: 0,
						stubbable: false,
						bytes: argsJson.length,
					});
				}
			}
		} else if (role === "toolResult") {
			const text = stripAcp(
				(m.content || [])
					.filter((b: any) => b.type === "text")
					.map((b: any) => String(b.text ?? ""))
					.join("\n"),
			);
			const cls = classifyTool(m.toolName);
			const lines = text.split("\n");
			const bytes = text.length;
			const tFull = estTokens(text);
			let tSnip = tFull;
			let tStub = tFull;
			if (cls === "read") {
				const ht = headTailTokens(lines, READ_HEAD, READ_TAIL);
				tSnip = ht < 0 ? tFull : ht;
				tStub = MARKER_TOKENS;
			} else if (cls === "command") {
				if (bytes > HEAD_TAIL_THRESHOLD) {
					const ht = headTailTokens(lines, CMD_HEAD, CMD_TAIL);
					tSnip = ht < 0 ? tFull : ht;
				}
				tStub =
					(lines.length > STUB_TAIL + 2 ? estTokens(lines.slice(-STUB_TAIL).join("\n")) : tFull) +
					MARKER_TOKENS;
			} else if (cls === "external") {
				if (bytes > HEAD_TAIL_THRESHOLD) {
					const ht = headTailTokens(lines, CMD_HEAD, CMD_TAIL);
					tSnip = ht < 0 ? tFull : ht;
				}
				tStub = estTokens(lines[0] ?? "") + EXTERNAL_MARKER_TOKENS;
			} else if (cls === "editWrite") {
				// Tier 1 不动；Tier 2 大 diff 按 bash 规则（尾 5 行 + 标记）
				if (bytes > HEAD_TAIL_THRESHOLD) {
					tStub = estTokens(lines.slice(-STUB_TAIL).join("\n")) + MARKER_TOKENS;
				}
			}
			const callInfo = m.toolCallId ? callPathById.get(m.toolCallId) : undefined;
			pushPart({
				cls,
				toolName: m.toolName,
				toolCallId: m.toolCallId,
				isError: m.isError === true,
				callPaths: callInfo?.paths.length ? callInfo.paths : undefined,
				text,
				tFull,
				tSnip,
				tStub,
				tFold: tFull,
				tTrim: tFull,
				stubbable: cls !== "protected",
				bytes,
			});
		}
	}
	return { file, chain, parts, stepAtPart, userTurnAtPart, steps, userTurns, calls, hasCompaction, hasAcp };
}

// ---------- 模拟 ----------

interface SimConfig {
	name: string;
	variant: "mono" | "naive";
	window: number;
	snipPct: number;
	prunePct: number;
	summarizePct: number;
	protectionTokens: number;
	t2scope: "all" | "gt4k";
	trimAssistantText: boolean;
}

interface StepRec {
	step: number;
	wire: number;
	cacheRead: number;
	cacheWrite: number;
	tier: number;
	newDecisions: number;
}

interface StubEvent {
	partIdx: number;
	stepIdx: number;
	userTurnIdx: number;
	path: string;
	toolName?: string;
}

interface SessionSimResult {
	file: string;
	stepsRec: StepRec[];
	t1Cross?: number;
	t2Cross?: number;
	t3Cross?: number;
	t3Count: number;
	stubEvents: StubEvent[];
	finalStubCount: number;
	cacheWriteSum: number;
	cacheReadSum: number;
	wireFinal: number;
	rawFinal: number;
	cold?: { live: number; cold: number; both: number; onlyLive: number; onlyCold: number };
}

function simSession(s: ChainSession, cfg: SimConfig, debug = false): SessionSimResult {
	const parts = s.parts;
	const n = parts.length;
	const state: PartState[] = new Array(n).fill("full");

	const stateTokens = (i: number, st: PartState): number => {
		const p = parts[i];
		switch (st) {
			case "snip":
				return p.tSnip;
			case "stub":
				return p.tStub;
			case "fold":
				return p.tFold;
			case "trim":
				return p.tTrim;
			default:
				return p.tFull;
		}
	};

	const cum = new Float64Array(n + 1);
	const rebuildCum = () => {
		for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + stateTokens(i, state[i]);
	};
	rebuildCum();

	const rawCum = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) rawCum[i + 1] = rawCum[i] + parts[i].tFull;

	// 前缀：截至 part i 的最近一次 isError toolResult 位置（保护区红线）
	const lastErrorUpTo: number[] = new Array(n).fill(-1);
	{
		let last = -1;
		for (let i = 0; i < n; i++) {
			if (parts[i].isError === true) last = i;
			lastErrorUpTo[i] = last;
		}
	}

	const isToolResult = (i: number) =>
		["read", "command", "external", "editWrite"].includes(parts[i].cls);

	/** 二分：第一个与尾部 token 保护区相交的 part 下标（含 sentLen 上界） */
	const zoneStartIdx = (sentLen: number, cumArr: Float64Array, window: number): number => {
		const zoneStartTok = Math.max(0, cumArr[sentLen] - window);
		let lo = 0;
		let hi = sentLen;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (cumArr[mid + 1] > zoneStartTok) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	};

	const stubbableNow = (i: number): boolean => {
		const p = parts[i];
		if (p.cls === "image") return true;
		if (!p.stubbable) return false;
		if (p.cls === "editWrite") return p.bytes > HEAD_TAIL_THRESHOLD && p.tStub < p.tFull;
		if (cfg.t2scope === "gt4k" && p.bytes <= HEAD_TAIL_THRESHOLD) return false;
		return p.tStub < p.tFull;
	};

	const stepsRec: StepRec[] = [];
	const stubEvents: StubEvent[] = [];
	let t1Cross: number | undefined;
	let t2Cross: number | undefined;
	let t3Cross: number | undefined;
	let t3Count = 0;
	let cacheWriteSum = 0;
	let cacheReadSum = 0;

	let prevSentStates: PartState[] | null = null;
	let prevSentTokens = 0;

	const cacheSplit = (sentLen: number): { read: number; write: number } => {
		if (prevSentStates === null) return { read: 0, write: cum[sentLen] };
		const m = Math.min(sentLen, prevSentStates.length);
		let i = 0;
		while (i < m && state[i] === prevSentStates[i]) i++;
		const read = cum[i];
		return { read, write: cum[sentLen] - read };
	};

	let partCursor = 0;
	for (let k = 0; k < s.steps; k++) {
		while (partCursor < n && s.stepAtPart[partCursor] <= k) partCursor++;
		const sentLen = partCursor;

		let tier = 0;
		let newDecisions = 0;

		if (cfg.variant === "mono") {
			const wireTok = cum[sentLen];
			const pct = (wireTok / cfg.window) * 100;
			const protIdx = new Set<number>();
			for (let i = zoneStartIdx(sentLen, cum, cfg.protectionTokens); i < sentLen; i++) protIdx.add(i);
			const errIdx = sentLen > 0 ? lastErrorUpTo[sentLen - 1] : -1;
			if (errIdx >= 0) protIdx.add(errIdx);

			/** 批量升级到 level，oldest-first，处理到 targetPct 下方或耗尽 */
			const applyBatch = (targetPct: number, level: "snip" | "stub"): number => {
				let changed = 0;
				let tok = cum[sentLen];
				for (let i = 0; i < sentLen; i++) {
					if ((tok / cfg.window) * 100 < targetPct) break;
					const p = parts[i];
					if (protIdx.has(i)) continue;
					if (level === "snip") {
						if (state[i] !== "full") continue;
						let target: PartState | null = null;
						if (p.cls === "read" && p.tSnip < p.tFull) target = "snip";
						else if (
							(p.cls === "command" || p.cls === "external") &&
							p.bytes > HEAD_TAIL_THRESHOLD &&
							p.tSnip < p.tFull
						)
							target = "snip";
						else if (p.cls === "userText" && p.tFold < p.tFull) target = "fold";
						if (!target) continue;
						tok -= stateTokens(i, state[i]) - stateTokens(i, target);
						state[i] = target;
						changed++;
					} else {
						if (state[i] === "stub" || !stubbableNow(i)) continue;
						if (p.cls !== "image" && !isToolResult(i)) continue;
						if (state[i] === "full" && p.cls === "editWrite" && p.tStub >= p.tFull) continue;
						tok -= stateTokens(i, state[i]) - stateTokens(i, "stub");
						const before = state[i];
						state[i] = "stub";
						changed++;
						if (before !== "stub" && p.callPaths?.length) {
							stubEvents.push({
								partIdx: i,
								stepIdx: k,
								userTurnIdx: s.userTurnAtPart[i],
								path: p.callPaths[0],
								toolName: p.toolName,
							});
						}
					}
				}
				if (changed > 0) rebuildCum();
				return changed;
			};

			if (pct >= cfg.snipPct) {
				tier = 1;
				if (t1Cross === undefined) t1Cross = k;
			}
			if (pct >= cfg.prunePct) {
				tier = 2;
				if (t2Cross === undefined) t2Cross = k;
			}
			if (tier === 2) {
				// 累积执行：先 Tier 1（snip/fold），再 Tier 2（stub）
				newDecisions += applyBatch(cfg.snipPct - HYSTERESIS_PCT, "snip");
				newDecisions += applyBatch(cfg.prunePct - HYSTERESIS_PCT, "stub");
				if (cfg.trimAssistantText) {
					let tok = cum[sentLen];
					for (let i = 0; i < sentLen; i++) {
						if ((tok / cfg.window) * 100 < cfg.prunePct - HYSTERESIS_PCT) break;
						const p = parts[i];
						if (p.cls !== "assistantText" || state[i] !== "full" || protIdx.has(i)) continue;
						if (p.tTrim >= p.tFull) continue;
						tok -= stateTokens(i, state[i]) - stateTokens(i, "trim");
						state[i] = "trim";
						newDecisions++;
					}
					rebuildCum();
				}
			} else if (tier === 1) {
				newDecisions += applyBatch(cfg.snipPct - HYSTERESIS_PCT, "snip");
			}
			if ((cum[sentLen] / cfg.window) * 100 >= cfg.summarizePct) {
				tier = 3;
				if (t3Cross === undefined) t3Cross = k;
				t3Count++;
			}
		} else {
			// naive-sliding：无决策记忆；gate = 上一步实际发送量（模拟无记忆实现读 API usage）
			const gatePct = (prevSentTokens / cfg.window) * 100;
			if (gatePct >= cfg.snipPct && sentLen > 0) {
				const zs = zoneStartIdx(sentLen, rawCum, cfg.protectionTokens);
				for (let i = 0; i < sentLen; i++) {
					if (!isToolResult(i)) continue;
					const next: PartState = i < zs && parts[i].tStub < parts[i].tFull ? "stub" : "full";
					state[i] = next;
				}
				tier = 2;
			} else {
				for (let i = 0; i < sentLen; i++) {
					if (isToolResult(i)) state[i] = "full";
				}
			}
			rebuildCum();
		}

		const { read, write } = cacheSplit(sentLen);
		stepsRec.push({ step: k, wire: cum[sentLen], cacheRead: read, cacheWrite: write, tier, newDecisions });
		cacheWriteSum += write;
		cacheReadSum += read;

		if (debug) {
			const d = `  step ${k} wire=${Math.round(cum[sentLen])} raw=${Math.round(rawCum[sentLen])}`;
			console.log(
				`${d} read=${Math.round(read)} write=${Math.round(write)} tier=${tier} nd=${newDecisions}`,
			);
		}

		prevSentStates = state.slice(0, sentLen);
		prevSentTokens = cum[sentLen];
	}

	const finalStubCount = state.reduce((acc, st) => acc + (st === "stub" ? 1 : 0), 0);

	// §15.5 冷启动探针（只对基准配置算）：终态 wire 上无记忆重算 stub 集，对比 live 决策集
	let cold: SessionSimResult["cold"] = undefined;
	if (cfg.name === "mono-p8k-t60-w128k" && n > 0) {
		const coldState: PartState[] = new Array(n).fill("full");
		const coldCum = new Float64Array(n + 1);
		const tk = (i: number) =>
			coldState[i] === "stub" ? parts[i].tStub : parts[i].tFull;
		const rebuild = () => {
			for (let i = 0; i < n; i++) coldCum[i + 1] = coldCum[i] + tk(i);
		};
		rebuild();
		const liveStub = new Set<number>();
		const coldStub = new Set<number>();
		for (let i = 0; i < n; i++) if (state[i] === "stub") liveStub.add(i);
		if ((coldCum[n] / cfg.window) * 100 >= cfg.prunePct) {
			const zs = zoneStartIdx(n, coldCum, cfg.protectionTokens);
			const errIdx = lastErrorUpTo[n - 1];
			for (let i = 0; i < n; i++) {
				if ((coldCum[n] / cfg.window) * 100 < cfg.prunePct - HYSTERESIS_PCT) break;
				if (i >= zs || i === errIdx) continue;
				if (parts[i].cls === "image") {
					coldState[i] = "stub";
					rebuild();
					continue;
				}
				if (!isToolResult(i)) continue;
				const p = parts[i];
				const ok =
					(p.cls === "editWrite"
						? p.bytes > HEAD_TAIL_THRESHOLD
						: cfg.t2scope === "all" || p.bytes > HEAD_TAIL_THRESHOLD) && p.tStub < p.tFull;
				if (!ok) continue;
				coldState[i] = "stub";
				rebuild();
			}
		}
		for (let i = 0; i < n; i++) if (coldState[i] === "stub") coldStub.add(i);
		let both = 0;
		for (const i of liveStub) if (coldStub.has(i)) both++;
		cold = {
			live: liveStub.size,
			cold: coldStub.size,
			both,
			onlyLive: liveStub.size - both,
			onlyCold: coldStub.size - both,
		};
	}

	return {
		file: s.file,
		stepsRec,
		t1Cross,
		t2Cross,
		t3Cross,
		t3Count,
		stubEvents,
		finalStubCount,
		cacheWriteSum,
		cacheReadSum,
		wireFinal: cum[n] || 0,
		rawFinal: rawCum[n] || 0,
		cold,
	};
}

// ---------- --core 同构模拟（离线/在线同一份决策逻辑，arch §9） ----------

interface CoreWire {
	messages: EvapWireMessage[];
	stepAtMessage: number[];
	userTurnAtMessage: number[];
	callPathById: Map<string, string[]>;
	droppedToolResultImages: number;
}

/** 主链 → 核心wire（基线同口径预处理：剥 ACP 标签；toolResult 图片 block 丢弃——
 * 基线 Part 模型不计，核心本身支持图片蒸发，此处仅为对齐既有基准） */
function buildCoreWire(chain: Entry[]): CoreWire {
	const messages: EvapWireMessage[] = [];
	const stepAtMessage: number[] = [];
	const userTurnAtMessage: number[] = [];
	const callPathById = new Map<string, string[]>();
	let steps = 0;
	let userTurns = 0;
	let droppedToolResultImages = 0;
	for (const e of chain) {
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		const role = m.role;
		if (role === "user") {
			userTurns++;
			let content: unknown;
			if (typeof m.content === "string") {
				content = stripAcp(m.content);
			} else {
				content = (m.content || []).map((b: any) => {
					if (b?.type === "text") return { ...b, text: stripAcp(String(b.text ?? "")) };
					if (b?.type === "image")
						return { type: "image", data: String(b.data ?? ""), mimeType: String(b.mimeType ?? "") };
					return b;
				});
			}
			messages.push({ ...m, role: "user", content });
			stepAtMessage.push(steps);
			userTurnAtMessage.push(userTurns);
		} else if (role === "assistant") {
			steps++;
			const content = (m.content || []).map((b: any) => {
				if (b?.type === "text") return { ...b, text: stripAcp(String(b.text ?? "")) };
				if (b?.type === "toolCall") {
					const paths = extractPathsFromCall(b.name, b.arguments);
					if (typeof b.id === "string" && paths.length) callPathById.set(b.id, paths);
					return { ...b };
				}
				return b;
			});
			messages.push({ ...m, role: "assistant", content });
			stepAtMessage.push(steps);
			userTurnAtMessage.push(userTurns);
		} else if (role === "toolResult") {
			const content = (m.content || []).flatMap((b: any) => {
				if (b?.type === "text") return [{ ...b, text: stripAcp(String(b.text ?? "")) }];
				if (b?.type === "image") {
					droppedToolResultImages++;
					return [];
				}
				return [b];
			});
			messages.push({ ...m, role: "toolResult", content, isError: m.isError === true });
			stepAtMessage.push(steps);
			userTurnAtMessage.push(userTurns);
		}
	}
	return { messages, stepAtMessage, userTurnAtMessage, callPathById, droppedToolResultImages };
}

function coreConfigOf(cfg: SimConfig): EvapConfig {
	return {
		tiers: { snip: cfg.snipPct, prune: cfg.prunePct, summarize: cfg.summarizePct },
		budgetTokens: cfg.window,
		protectionTokens: cfg.protectionTokens,
		headLines: 15,
		tailLines: 25,
		headTailThreshold: HEAD_TAIL_THRESHOLD,
		tier2Scope: cfg.t2scope,
		trimAssistantText: cfg.trimAssistantText,
		protectedTools: ["todo"],
	};
}

/** --core 模式模拟：每 step 用核心 evaporateWire 驱动，指标从 inspectParts 派生 */
function simSessionCore(s: ChainSession, wire: CoreWire, cfg: SimConfig): SessionSimResult {
	const coreConfig = coreConfigOf(cfg);
	const state = createEvapState();
	const stepsRec: StepRec[] = [];
	const stubEvents: StubEvent[] = [];
	let t1Cross: number | undefined;
	let t2Cross: number | undefined;
	let t3Cross: number | undefined;
	let t3Count = 0;
	let cacheWriteSum = 0;
	let cacheReadSum = 0;
	let prevLevels: string[] | null = null;
	let alignmentMismatches = 0;

	let msgCursor = 0;
	let partCursor = 0; // ChainSession 侧对齐校验游标
	for (let k = 0; k < s.steps; k++) {
		while (msgCursor < wire.messages.length && wire.stepAtMessage[msgCursor] <= k) msgCursor++;
		const visible = wire.messages.slice(0, msgCursor);
		const res = evaporateWire(visible, state, coreConfig, { windowTokens: cfg.window, usageTokens: null });
		const views = inspectParts(visible, state, coreConfig);
		while (partCursor < s.parts.length && s.stepAtPart[partCursor] <= k) partCursor++;
		if (views.length !== partCursor) alignmentMismatches++;

		let wireTokens = 0;
		for (const v of views) wireTokens += v.tokens;
		// cacheSplit：第一个状态变化 part 前的前缀 token
		let i = 0;
		const m = Math.min(views.length, prevLevels?.length ?? 0);
		while (i < m && views[i]?.level === prevLevels?.[i]) i++;
		let read = 0;
		for (let j = 0; j < i; j++) read += views[j]?.tokens ?? 0;
		const write = wireTokens - read;

		const tier = res.batch.tier;
		if (tier >= 1 && t1Cross === undefined) t1Cross = k;
		if (tier >= 2 && t2Cross === undefined) t2Cross = k;
		if (tier === 3) {
			if (t3Cross === undefined) t3Cross = k;
			t3Count++;
		}
		// 新 stub 事件（误杀分析用；与 replay stubEvents 同构）
		for (let pi = 0; pi < views.length; pi++) {
			const v = views[pi];
			if (!v || v.level !== "stub" || prevLevels?.[pi] === "stub") continue;
			if (!v.toolCallId) continue;
			const paths = wire.callPathById.get(v.toolCallId);
			if (!paths?.length) continue;
			stubEvents.push({
				partIdx: pi,
				stepIdx: k,
				userTurnIdx: s.userTurnAtPart[pi] ?? 0,
				path: paths[0],
				toolName: undefined, // 误杀分析不消费（analyzeMisEviction 只读 path/step/turn）
			});
		}

		stepsRec.push({
			step: k,
			wire: wireTokens,
			cacheRead: read,
			cacheWrite: write,
			tier,
			newDecisions: res.batch.snipped + res.batch.pruned,
		});
		cacheWriteSum += write;
		cacheReadSum += read;
		prevLevels = views.map((v) => v.level);
	}
	if (alignmentMismatches > 0) {
		console.warn(
			`[core-align] ${s.file}: ${alignmentMismatches} step(s) part 数与基线不对齐（丢弃图片 ${wire.droppedToolResultImages}）`,
		);
	}

	const finalViews = inspectParts(wire.messages, state, coreConfig);
	const finalStubCount = finalViews.reduce((acc, v) => acc + (v.level === "stub" ? 1 : 0), 0);
	let wireFinal = 0;
	let rawFinal = 0;
	for (const v of finalViews) {
		wireFinal += v.tokens;
		rawFinal += v.tFull;
	}

	// §15.5 冷启动探针（只对基准配置算）：终态 wire 上无记忆重算 stub 集，对比 live 决策集
	let cold: SessionSimResult["cold"] = undefined;
	if (cfg.name === "mono-p8k-t60-w128k") {
		const liveStub = new Set<number>();
		for (let i = 0; i < finalViews.length; i++) if (finalViews[i]?.level === "stub") liveStub.add(i);
		// stub-only：snip 线设为不可达，等价于 replay 冷探针的「只升级 stub」语义
		const coldState = createEvapState();
		evaporateWire(wire.messages, coldState, {
			...coreConfig,
			tiers: { snip: 1001, prune: cfg.prunePct, summarize: cfg.summarizePct },
		}, { windowTokens: cfg.window, usageTokens: null });
		const coldViews = inspectParts(wire.messages, coldState, coreConfig);
		const coldStub = new Set<number>();
		for (let i = 0; i < coldViews.length; i++) if (coldViews[i]?.level === "stub") coldStub.add(i);
		let both = 0;
		for (const i of liveStub) if (coldStub.has(i)) both++;
		cold = {
			live: liveStub.size,
			cold: coldStub.size,
			both,
			onlyLive: liveStub.size - both,
			onlyCold: coldStub.size - both,
		};
	}

	return {
		file: s.file,
		stepsRec,
		t1Cross,
		t2Cross,
		t3Cross,
		t3Count,
		stubEvents,
		finalStubCount,
		cacheWriteSum,
		cacheReadSum,
		wireFinal,
		rawFinal,
		cold,
	};
}

// ---------- 误杀 / 振荡 / §15.2 探针 ----------

interface MisEvictStats {
	stubbedWithPath: number;
	misKilledUserTurns: number; // ≤3 user 轮（handoff 主口径）
	misKilledSteps: number; // ≤20 steps（补充口径）
	misKilledLoose: number; // 宽松口径：basename 相同即算召回
	recalledEver: number;
	distanceSteps: number[];
	distanceUserTurns: number[];
	oscillatorPaths: number;
	neverResurfaced: number; // §15.2：无 recall 且特征行未出现在后续 assistant 文本
	surfacedOrRecalled: number;
}

function basename(p: string): string {
	const segs = p.split("/");
	return segs[segs.length - 1] || p;
}

function analyzeMisEviction(s: ChainSession, res: SessionSimResult): MisEvictStats {
	const stats: MisEvictStats = {
		stubbedWithPath: 0,
		misKilledUserTurns: 0,
		misKilledSteps: 0,
		misKilledLoose: 0,
		recalledEver: 0,
		distanceSteps: [],
		distanceUserTurns: [],
		oscillatorPaths: 0,
		neverResurfaced: 0,
		surfacedOrRecalled: 0,
	};
	if (res.stubEvents.length === 0) return stats;

	const recalls = s.calls.filter((c) => c.paths.length > 0);
	// assistant 文本按 step 索引（§15.2 探针）
	const textChunksByStep = new Map<number, string[]>();
	for (let i = 0; i < s.parts.length; i++) {
		const p = s.parts[i];
		if (p.cls !== "assistantText" || !p.text) continue;
		const st = s.stepAtPart[i];
		const arr = textChunksByStep.get(st) ?? [];
		arr.push(p.text);
		textChunksByStep.set(st, arr);
	}
	const textAfter = (fromStep: number, toStep: number): string => {
		const chunks: string[] = [];
		for (const [st, arr] of textChunksByStep) {
			if (st > fromStep && st <= toStep) chunks.push(arr.join("\n"));
		}
		return chunks.join("\n");
	};

	const perPathTimeline = new Map<string, { at: number; kind: "stub" | "recall" }[]>();
	const pushTl = (path: string, at: number, kind: "stub" | "recall") => {
		let tl = perPathTimeline.get(path);
		if (!tl) {
			tl = [];
			perPathTimeline.set(path, tl);
		}
		tl.push({ at, kind });
	};

	for (const ev of res.stubEvents) {
		stats.stubbedWithPath++;
		pushTl(ev.path, ev.stepIdx, "stub");

		// 同路径 recall（含同 step：stub 在 wire 里，模型的反应可以是本 step 的调用）
		let recall: CallRec | undefined;
		for (const c of recalls) {
			if (c.stepIdx >= ev.stepIdx && c.paths.includes(ev.path)) {
				recall = c;
				break;
			}
		}
		// 宽松口径：basename 命中（排除产生该结果的原始调用自身）
		if (!recall) {
			const bn = basename(ev.path);
			for (const c of recalls) {
				if (c.stepIdx >= ev.stepIdx && c.paths.some((p2) => basename(p2) === bn)) {
					stats.misKilledLoose++;
					break;
				}
			}
		}
		const endStep = recall ? recall.stepIdx : s.steps;
		if (recall) {
			stats.recalledEver++;
			const dSteps = recall.stepIdx - ev.stepIdx;
			const dTurns = recall.userTurnIdx - ev.userTurnIdx;
			stats.distanceSteps.push(dSteps);
			stats.distanceUserTurns.push(dTurns);
			if (dTurns <= MIS_KILL_USER_TURNS) stats.misKilledUserTurns++;
			if (dSteps <= MIS_KILL_STEPS) stats.misKilledSteps++;
		}
		// §15.2：stub→recall/end 窗口内，原文特征行是否出现在 assistant 文本
		const text = s.parts[ev.partIdx]?.text ?? "";
		const lines = text
			.split("\n")
			.filter((l) => l.length >= 40 && /\d|[A-Za-z_]{4}/.test(l))
			.slice(0, 3);
		if (lines.length > 0) {
			const later = textAfter(ev.stepIdx, endStep);
			const anyFound = lines.some((l) => later.includes(l.slice(0, 60)));
			if (anyFound || recall) stats.surfacedOrRecalled++;
			else stats.neverResurfaced++;
		}
	}
	for (const c of recalls) {
		for (const path of c.paths) pushTl(path, c.stepIdx, "recall");
	}
	for (const [, tl] of perPathTimeline) {
		tl.sort((a, b) => a.at - b.at);
		let armed = false;
		let cycles = 0;
		for (const e of tl) {
			if (e.kind === "stub") armed = true;
			else if (e.kind === "recall" && armed) {
				cycles++;
				armed = false;
			}
		}
		if (cycles >= 2) stats.oscillatorPaths++;
	}
	return stats;
}

// ---------- 配置网格 ----------

const ALL_CONFIGS: SimConfig[] = [];
{
	const protections = [4000, 8000, 16000];
	const tierSets = [
		{ name: "t60", snip: 60, prune: 80, sum: 95 },
		{ name: "t70", snip: 70, prune: 85, sum: 95 },
		{ name: "t6085", snip: 60, prune: 85, sum: 95 }, // 2026-08-26 方案 B 定稿档线（spec §9）
	];
	const windows = [128000, 160000, 200000, 256000, 1000000]; // 128K 定稿档 + 160K/256K budget 补核档 + 200K 外推档 + 1M（deepseek-v4 等 models-store 实际窗口）
	for (const variant of ["mono", "naive"] as const) {
		for (const p of protections) {
			for (const t of tierSets) {
				for (const w of windows) {
					ALL_CONFIGS.push({
						name: `${variant}-p${p / 1000}k-${t.name}-w${w / 1000}k`,
						variant,
						window: w,
						snipPct: t.snip,
						prunePct: t.prune,
						summarizePct: t.sum,
						protectionTokens: p,
						t2scope: "all",
						trimAssistantText: false,
					});
				}
			}
		}
	}
	// 基线 + 敏感度附加
	ALL_CONFIGS.push(
		{
			name: "raw",
			variant: "mono",
			window: Number.MAX_SAFE_INTEGER, // 真・不触发：避免超窗会话 pct≥101% 假蒸发
			snipPct: 101,
			prunePct: 101,
			summarizePct: 101,
			protectionTokens: 8000,
			t2scope: "all",
			trimAssistantText: false,
		},
		{
			name: "mono-p8k-t60-w128k-t2gt4k",
			variant: "mono",
			window: 128000,
			snipPct: 60,
			prunePct: 80,
			summarizePct: 95,
			protectionTokens: 8000,
			t2scope: "gt4k",
			trimAssistantText: false,
		},
		{
			name: "mono-p8k-t60-w128k-trim",
			variant: "mono",
			window: 128000,
			snipPct: 60,
			prunePct: 80,
			summarizePct: 95,
			protectionTokens: 8000,
			t2scope: "all",
			trimAssistantText: true,
		},
	);
}

function buildConfigs(): SimConfig[] {
	if (CONFIGS === "grid") return ALL_CONFIGS;
	const wanted = new Set(CONFIGS.split(",").map((x) => x.trim()));
	return ALL_CONFIGS.filter((c) => wanted.has(c.name));
}

// ---------- 聚合 ----------

interface ConfigAggregate {
	name: string;
	sessions: number;
	sessionsT1: number;
	sessionsT2: number;
	sessionsT3: number;
	t3Files: string[];
	mis: MisEvictStats;
	cacheWriteTotal: number;
	cacheReadTotal: number;
	cacheWriteMeanPerStep: number;
	plateauSlopeRatio: number | null;
	plateauSessions: number;
	longCacheWriteMean: number | null;
	longSessions: number;
	finalWireMeanLong: number | null;
	rawFinalMeanLong: number | null;
}

/** wire 截至 step k（含）时的 raw 全量 token */
function rawTokensAtStep(s: ChainSession, step: number): number {
	let sum = 0;
	for (let i = 0; i < s.parts.length; i++) {
		if (s.stepAtPart[i] > step) break;
		sum += s.parts[i].tFull;
	}
	return sum;
}

function aggregate(
	name: string,
	results: SessionSimResult[],
	sessions: Map<string, ChainSession>,
): ConfigAggregate {
	let sessionsT1 = 0;
	let sessionsT2 = 0;
	let sessionsT3 = 0;
	const t3Files: string[] = [];
	const mis: MisEvictStats = {
		stubbedWithPath: 0,
		misKilledUserTurns: 0,
		misKilledSteps: 0,
		misKilledLoose: 0,
		recalledEver: 0,
		distanceSteps: [],
		distanceUserTurns: [],
		oscillatorPaths: 0,
		neverResurfaced: 0,
		surfacedOrRecalled: 0,
	};
	let cacheWriteTotal = 0;
	let cacheReadTotal = 0;
	let stepCount = 0;
	let slopeRatioSum = 0;
	let plateauSessions = 0;
	let longWriteSum = 0;
	let longSteps = 0;
	let longSessions = 0;
	let longWireSum = 0;
	let longRawSum = 0;

	for (const r of results) {
		if (r.t1Cross !== undefined) sessionsT1++;
		if (r.t2Cross !== undefined) sessionsT2++;
		if (r.t3Cross !== undefined) {
			sessionsT3++;
			t3Files.push(r.file.split("/").slice(-2).join("/").slice(0, 40));
		}
		const s = sessions.get(r.file);
		if (s) {
			const m = analyzeMisEviction(s, r);
			mis.stubbedWithPath += m.stubbedWithPath;
			mis.misKilledUserTurns += m.misKilledUserTurns;
			mis.misKilledSteps += m.misKilledSteps;
			mis.misKilledLoose += m.misKilledLoose;
			mis.recalledEver += m.recalledEver;
			mis.distanceSteps.push(...m.distanceSteps);
			mis.distanceUserTurns.push(...m.distanceUserTurns);
			mis.oscillatorPaths += m.oscillatorPaths;
			mis.neverResurfaced += m.neverResurfaced;
			mis.surfacedOrRecalled += m.surfacedOrRecalled;

			// 平台期：T1 交叉后蒸发增速 / raw 增速
			if (r.t1Cross !== undefined && r.stepsRec.length > r.t1Cross + 10) {
				const c = r.t1Cross;
				const wireAtCross = r.stepsRec[c].wire;
				const wireFinal = r.stepsRec[r.stepsRec.length - 1].wire;
				const rawAtCross = rawTokensAtStep(s, r.stepsRec[c].step);
				const rawFinalAtLast = rawTokensAtStep(s, r.stepsRec[r.stepsRec.length - 1].step);
				const stepsAfter = r.stepsRec.length - c;
				const evapSlope = (wireFinal - wireAtCross) / stepsAfter;
				const rawSlope = (rawFinalAtLast - rawAtCross) / stepsAfter;
				if (rawSlope > 0) {
					slopeRatioSum += evapSlope / rawSlope;
					plateauSessions++;
				}
			}
			if (s.steps >= 150) {
				longSessions++;
				longWriteSum += r.cacheWriteSum;
				longSteps += r.stepsRec.length;
				longWireSum += r.wireFinal;
				longRawSum += r.rawFinal;
			}
		}
		cacheWriteTotal += r.cacheWriteSum;
		cacheReadTotal += r.cacheReadSum;
		stepCount += r.stepsRec.length;
	}

	return {
		name,
		sessions: results.length,
		sessionsT1,
		sessionsT2,
		sessionsT3,
		t3Files,
		mis,
		cacheWriteTotal,
		cacheReadTotal,
		cacheWriteMeanPerStep: stepCount > 0 ? cacheWriteTotal / stepCount : 0,
		plateauSlopeRatio: plateauSessions > 0 ? slopeRatioSum / plateauSessions : null,
		plateauSessions,
		longCacheWriteMean: longSteps > 0 ? longWriteSum / longSteps : null,
		longSessions,
		finalWireMeanLong: longSessions > 0 ? longWireSum / longSessions : null,
		rawFinalMeanLong: longSessions > 0 ? longRawSum / longSessions : null,
	};
}

// ---------- 主流程 ----------

function listSessionFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(d, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (name === "traces") continue;
				walk(full);
			} else if (name.endsWith(".jsonl")) {
				if (name.startsWith("trace-")) continue; // 事件 trace 非会话（subagent 目录平铺存放）
				out.push(full);
			}
		}
	};
	walk(dir);
	out.sort();
	return out;
}

function fmt(n: number | null | undefined, digits = 0): string {
	if (n === null || n === undefined) return "-";
	return n.toFixed(digits);
}

async function main() {
	if (DATA_DIR.includes(homedir()) && !DATA_DIR.includes("replay-data")) {
		console.error(`[abort] data dir 指向正式目录：${DATA_DIR}（replay 只允许跑副本）`);
		process.exit(1);
	}
	const files = listSessionFiles(DATA_DIR).filter((f) => (ONLY ? f.includes(ONLY) : true));
	const limited = LIMIT ? files.slice(0, LIMIT) : files;
	const configs = buildConfigs();
	if (configs.length === 0) {
		console.error("[abort] 未匹配到配置");
		process.exit(1);
	}
	const cfgNames = configs.map((c) => c.name).join(",");
	console.log(
		`[replay] data=${DATA_DIR} files=${limited.length}/${files.length} configs=${cfgNames}${CORE ? " core=on" : ""}`,
	);

	mkdirSync(OUT_DIR, { recursive: true });
	mkdirSync(join(OUT_DIR, "runs"), { recursive: true });

	const sessions = new Map<string, ChainSession>();
	const perConfig = new Map<string, SessionSimResult[]>();
	for (const c of configs) perConfig.set(c.name, []);

	let nSessions = 0;
	let totalSteps = 0;
	const longSessionsForCurves = new Set<string>();

	for (const file of limited) {
		let s: ChainSession;
		try {
			s = loadSession(file);
		} catch (err) {
			console.warn(`[warn] 解析失败 ${file}: ${err}`);
			continue;
		}
		if (s.steps === 0) continue;
		sessions.set(s.file, s);
		nSessions++;
		totalSteps += s.steps;
		if (s.steps >= 200) longSessionsForCurves.add(s.file);

		const coreWires = new Map<SimConfig, SessionSimResult>();
		if (CORE) {
			const wire = buildCoreWire(s.chain);
			for (const cfg of configs) {
				if (cfg.variant !== "mono") continue;
				coreWires.set(cfg, simSessionCore(s, wire, cfg));
			}
		}
		for (const cfg of configs) {
			const coreResult = coreWires.get(cfg);
			const res = coreResult ?? simSession(s, cfg, DEBUG && configs.length === 1);
			perConfig.get(cfg.name)?.push(res);
		}
	}
	console.log(`[replay] sessions=${nSessions} steps=${totalSteps} 曲线样本(≥200步)=${longSessionsForCurves.size}`);

	// calls 全量导出（配置无关；供基线重读率等离线分析）
	writeFileSync(
		join(OUT_DIR, "calls.json"),
		JSON.stringify(
			[...sessions.values()].map((s) => ({
				file: s.file,
				steps: s.steps,
				userTurns: s.userTurns,
				calls: s.calls.filter((c) => c.paths.length > 0).map((c) => [c.stepIdx, c.userTurnIdx, c.paths]),
			})),
		),
	);

	const aggRows: ConfigAggregate[] = [];
	for (const cfg of configs) {
		const results = perConfig.get(cfg.name) ?? [];
		const agg = aggregate(cfg.name, results, sessions);
		aggRows.push(agg);
		writeFileSync(
			join(OUT_DIR, "runs", `${cfg.name}.json`),
			JSON.stringify(
				{
					config: cfg,
					aggregate: { ...agg, mis: { ...agg.mis, distanceSteps: undefined, distanceUserTurns: undefined } },
					sessions: results.map((r) => ({
						file: r.file,
						steps: r.stepsRec.length,
						t1: r.t1Cross ?? null,
						t2: r.t2Cross ?? null,
						t3: r.t3Cross ?? null,
						t3Count: r.t3Count,
						stubs: r.finalStubCount,
						cacheWriteSum: Math.round(r.cacheWriteSum),
						cacheReadSum: Math.round(r.cacheReadSum),
						wireFinal: Math.round(r.wireFinal),
						rawFinal: Math.round(r.rawFinal),
						cold: r.cold ?? null,
					})),
					misDistanceSteps: agg.mis.distanceSteps,
					misDistanceUserTurns: agg.mis.distanceUserTurns,
				},
				null,
				"\t",
			),
		);
	}

	// 曲线数据：raw / mono 基准 / naive 基准（≥200 步长会话）
	const curveCfg = ["raw", "mono-p8k-t60-w128k", "naive-p8k-t60-w128k"].filter((n) => perConfig.has(n));
	const curves: Record<string, unknown> = {};
	for (const cname of curveCfg) {
		const rs = (perConfig.get(cname) ?? []).filter((r) => longSessionsForCurves.has(r.file));
		curves[cname] = rs.map((r) => ({
			file: r.file,
			steps: r.stepsRec.map((x) => ({
				s: x.step,
				w: Math.round(x.wire),
				r: Math.round(x.cacheRead),
				cw: Math.round(x.cacheWrite),
			})),
		}));
	}
	writeFileSync(join(OUT_DIR, "curves-long.json"), JSON.stringify(curves));

	console.log("\n=== 汇总（全部会话） ===");
	console.log("config | T1/T2/T3会话 | 误杀u3 | 误杀s20 | 宽松 | 蒸发数 | 振荡 | 静默 | cw/step | 长cw/step | 平台期比");
	for (const a of aggRows) {
		const den = a.mis.stubbedWithPath;
		const u3 = den > 0 ? a.mis.misKilledUserTurns : 0;
		const s20 = den > 0 ? a.mis.misKilledSteps : 0;
		const parts = [
			a.name,
			`${a.sessionsT1}/${a.sessionsT2}/${a.sessionsT3}`,
			u3,
			s20,
			a.mis.misKilledLoose,
			den,
			a.mis.oscillatorPaths,
			a.mis.neverResurfaced,
			fmt(a.cacheWriteMeanPerStep, 1),
			fmt(a.longCacheWriteMean, 1),
			fmt(a.plateauSlopeRatio, 2),
		];
		console.log(parts.join(" | "));
	}
	console.log(`\n[out] ${OUT_DIR}/runs/*.json, curves-long.json`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
