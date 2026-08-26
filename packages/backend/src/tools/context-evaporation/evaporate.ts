/**
 * 蒸发核心（纯函数，零 SDK/零仓库 import，除同目录 types/estimate）。
 *
 * 职责：wire 消息 → 四级水位线决策（决策单调持久化）→ 新 wire。
 * 规则唯一权威 spec §3-§7；决策状态机与 scripts/replay-evaporation.mts 的
 * simSession（mono 变体）逐字节同构——常量、批停机、保护区、oldest-first 大跳
 * 全部按 replay 口径移植，离线调参结论因此对线上实现成立（arch §9）。
 *
 * 约束：
 * - 本模块绝不 throw（非法 part 形态一律视为不可蒸发跳过）；调用方（extension.ts）
 *   另有全量 try/catch 兜底。
 * - 未蒸发消息保持对象身份；有蒸发时返回新数组，不改入参。
 * - 决策 Map 只升不降（full→snip→stub）；stub/snip 文本 = part 的纯函数。
 */

import { createHash } from "node:crypto";
import { estTokens, IMAGE_FULL_TOKENS, IMAGE_STUB_TOKENS } from "./estimate";
import type {
	EvapBatchInfo,
	EvapClass,
	EvapConfig,
	EvapDecisionMap,
	EvapImageBlock,
	EvapLevel,
	EvapPartInfo,
	EvapPartView,
	EvapState,
	EvapTextBlock,
	EvapWireMessage,
} from "./types";

// ---------- 常量（replay 对齐口径，勿改——改了同构验证即失配） ----------

/** 「[输出已淘汰：…]」类标记行 token（replay MARKER_TOKENS） */
const MARKER_TOKENS = 30;
/** external 类 stub 标记 token（replay EXTERNAL_MARKER_TOKENS，含首行提示） */
const EXTERNAL_MARKER_TOKENS = 40;
/** 用户贴的代码块折叠阈值（字节 + 行数双门槛的字节项） */
const FOLD_BLOCK_MIN_BYTES = 512;
/** 用户代码块折叠保留头行数（replay 固定 5，非配置项） */
const FOLD_HEAD_LINES = 5;
/** Tier 内 hysteresis 缓冲：跨线触发后处理到「触发线 − 5%」或候选耗尽（replay HYSTERESIS_PCT） */
const HYSTERESIS_PCT = 5;
/** read 类 snip 头/尾行数（spec §5 固定 10/5，非配置项） */
const READ_HEAD = 10;
const READ_TAIL = 5;
/** stub 保留尾部行数（spec §6 bash/editWrite 模板「尾 5 行」） */
const STUB_TAIL = 5;

// ---------- key 生成（arch §4.1） ----------

function sha12(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function userTextKey(text: string): string {
	return `h:${sha12(text)}`;
}

function userImageKey(data: string): string {
	return `h:img:${data.length}:${data.slice(0, 64)}`;
}

function assistantTextKey(text: string): string {
	return `ha:${sha12(text)}`;
}

// ---------- token 尺寸（replay 逐字节对齐） ----------

/** 头尾截断 token；太短不值得截断返回 -1 */
function headTailTokens(lines: string[], head: number, tail: number): number {
	if (lines.length <= head + tail + 2) return -1;
	return (
		estTokens(lines.slice(0, head).join("\n")) + estTokens(lines.slice(-tail).join("\n")) + MARKER_TOKENS
	);
}

/** 用户文本：代码块折叠 token（块外原文 + 大块头 5 行 + 标注）；无可折叠大块返回 -1 */
function foldUserTokens(text: string): number {
	const parts = text.split("```");
	if (parts.length < 3) return -1;
	let hasBigBlock = false;
	let total = 0;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] ?? "";
		if (i % 2 === 0) {
			total += estTokens(part);
			continue;
		}
		const lines = part.split("\n");
		if (part.length >= FOLD_BLOCK_MIN_BYTES && lines.length > 7) {
			hasBigBlock = true;
			total += estTokens(lines.slice(0, FOLD_HEAD_LINES).join("\n")) + MARKER_TOKENS;
		} else {
			total += estTokens(part);
		}
	}
	return hasBigBlock ? total : -1;
}

/** assistant 文本：留前两句 + 标记（仅 trimAssistantText=true 路径） */
function trimAssistantTokens(text: string): number {
	const sents = text.split(/(?<=[。！？.!?\n])/);
	return estTokens(sents.slice(0, 2).join("")) + MARKER_TOKENS;
}

// ---------- part 提取 ----------

function classifyTool(toolName: string | undefined, protectedTools: string[]): EvapClass {
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
		default:
			if (toolName && protectedTools.includes(toolName)) return "protected";
			return "command"; // bash / ls / find / subagent / 其余
	}
}

function isToolResultCls(cls: EvapClass): boolean {
	return cls === "read" || cls === "command" || cls === "external" || cls === "editWrite";
}

/** 替换文本 block 的正文（签名随原文字节失效，一并删除） */
function replaceTextBlock(b: EvapTextBlock, text: string): EvapTextBlock {
	const copy = { ...b, text };
	delete copy.textSignature;
	return copy;
}

function isEvapTextBlock(b: unknown): b is EvapTextBlock {
	return (
		typeof b === "object" &&
		b !== null &&
		(b as { type?: unknown }).type === "text" &&
		typeof (b as { text?: unknown }).text === "string"
	);
}

function isEvapImageBlock(b: unknown): b is EvapImageBlock {
	return (
		typeof b === "object" &&
		b !== null &&
		(b as { type?: unknown }).type === "image" &&
		typeof (b as { data?: unknown }).data === "string"
	);
}

/** 单条消息 → part 静态信息（纯函数；custom/bashExecution 等返回空数组，不碰不计） */
function extractMessageParts(msg: EvapWireMessage, messageIndex: number, config: EvapConfig): EvapPartInfo[] {
	const role = (msg as { role?: unknown }).role;
	if (role === "user") {
		const content = msg.content;
		const out: EvapPartInfo[] = [];
		if (typeof content === "string") {
			const tFull = estTokens(content);
			const fold = foldUserTokens(content);
			out.push({
				cls: "userText",
				kind: "userString",
				key: userTextKey(content),
				messageIndex,
				blockIndex: -1,
				text: content,
				tFull,
				tSnip: tFull,
				tStub: tFull,
				tFold: fold < 0 ? tFull : fold,
				tTrim: tFull,
				stubbable: false,
				bytes: content.length,
			});
			return out;
		}
		if (!Array.isArray(content)) return out;
		for (let i = 0; i < content.length; i++) {
			const b = content[i];
			if (isEvapTextBlock(b)) {
				const text = b.text;
				const tFull = estTokens(text);
				const fold = foldUserTokens(text);
				out.push({
					cls: "userText",
					kind: "userText",
					key: userTextKey(text),
					messageIndex,
					blockIndex: i,
					text,
					tFull,
					tSnip: tFull,
					tStub: tFull,
					tFold: fold < 0 ? tFull : fold,
					tTrim: tFull,
					stubbable: false,
					bytes: text.length,
				});
			} else if (isEvapImageBlock(b)) {
				out.push({
					cls: "image",
					kind: "userImage",
					key: userImageKey(b.data),
					messageIndex,
					blockIndex: i,
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
		return out;
	}
	if (role === "assistant") {
		const content = msg.content;
		const out: EvapPartInfo[] = [];
		if (!Array.isArray(content)) return out;
		for (let i = 0; i < content.length; i++) {
			const b = content[i];
			if (typeof b !== "object" || b === null) continue;
			const t = (b as { type?: unknown }).type;
			if (t === "thinking") continue; // wire 不回传 thinking（replay 同款）
			if (t === "text" && typeof (b as { text?: unknown }).text === "string") {
				const text = (b as EvapTextBlock).text;
				const tFull = estTokens(text);
				out.push({
					cls: "assistantText",
					kind: "assistantText",
					key: assistantTextKey(text),
					messageIndex,
					blockIndex: i,
					text,
					tFull,
					tSnip: tFull,
					tStub: tFull,
					tFold: tFull,
					tTrim: text.length > 400 ? trimAssistantTokens(text) : tFull,
					stubbable: false,
					bytes: text.length,
				});
			} else if (t === "toolCall") {
				const call = b as { id?: unknown; name?: unknown; arguments?: unknown };
				const argsJson = JSON.stringify(call.arguments ?? {});
				const tFull = estTokens(argsJson) + MARKER_TOKENS;
				out.push({
					cls: "toolCall",
					kind: "toolCall",
					key: `call:${typeof call.id === "string" ? call.id : sha12(argsJson)}`,
					messageIndex,
					blockIndex: i,
					toolName: typeof call.name === "string" ? call.name : undefined,
					tFull,
					tSnip: 0,
					tStub: 0,
					tFold: 0,
					tTrim: 0,
					stubbable: false,
					bytes: argsJson.length,
				});
			}
		}
		return out;
	}
	if (role === "toolResult") {
		const tr = msg as {
			toolCallId?: unknown;
			toolName?: unknown;
			content?: unknown;
			isError?: unknown;
			details?: unknown;
		};
		const toolName = typeof tr.toolName === "string" ? tr.toolName : undefined;
		const toolCallId = typeof tr.toolCallId === "string" ? tr.toolCallId : "";
		const blocks = Array.isArray(tr.content) ? tr.content : [];
		const pinned =
			typeof tr.details === "object" &&
			tr.details !== null &&
			(tr.details as { compactionProtected?: unknown }).compactionProtected === true;
		const out: EvapPartInfo[] = [];
		const textBlocks: Array<{ index: number; text: string }> = [];
		let imageIdx = 0;
		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i];
			if (isEvapTextBlock(b)) textBlocks.push({ index: i, text: b.text });
		}
		// 文本 part：全部 text block 拼接为一个决策单元（replay 同款）；空文本也保留占位
		const text = textBlocks.map((tb) => tb.text).join("\n");
		const cls = pinned ? "protected" : classifyTool(toolName, config.protectedTools);
		const lines = text.split("\n");
		const bytes = text.length;
		const tFull = estTokens(text);
		let tSnip = tFull;
		let tStub = tFull;
		if (cls === "read") {
			const ht = headTailTokens(lines, READ_HEAD, READ_TAIL);
			tSnip = ht < 0 ? tFull : ht;
			tStub = MARKER_TOKENS;
		} else if (cls === "command" || cls === "external") {
			if (bytes > config.headTailThreshold) {
				const ht = headTailTokens(lines, config.headLines, config.tailLines);
				tSnip = ht < 0 ? tFull : ht;
			}
			tStub =
				cls === "external"
					? estTokens(lines[0] ?? "") + EXTERNAL_MARKER_TOKENS
					: (lines.length > STUB_TAIL + 2 ? estTokens(lines.slice(-STUB_TAIL).join("\n")) : tFull) +
						MARKER_TOKENS;
		} else if (cls === "editWrite") {
			// Tier 1 不动；Tier 2 大 diff 按尾 5 行 + 标记
			if (bytes > config.headTailThreshold) {
				tStub = estTokens(lines.slice(-STUB_TAIL).join("\n")) + MARKER_TOKENS;
			}
		}
		out.push({
			cls,
			kind: "trText",
			key: toolCallId ? `tr:${toolCallId}` : `tr:noid:${sha12(text)}`,
			messageIndex,
			blockIndex: textBlocks.length > 0 ? (textBlocks[0]?.index ?? -1) : -1,
			toolCallId,
			toolName,
			isError: tr.isError === true,
			pinned,
			text,
			tFull,
			tSnip,
			tStub,
			tFold: tFull,
			tTrim: tFull,
			stubbable: cls !== "protected",
			bytes,
		});
		// 图片 part：原位换占位文本（Tier 2）
		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i];
			if (isEvapImageBlock(b)) {
				out.push({
					cls: "image",
					kind: "trImage",
					key: `tr:${toolCallId}:img${imageIdx}`,
					messageIndex,
					blockIndex: i,
					toolCallId,
					toolName,
					tFull: IMAGE_FULL_TOKENS,
					tSnip: IMAGE_FULL_TOKENS,
					tStub: IMAGE_STUB_TOKENS,
					tFold: IMAGE_FULL_TOKENS,
					tTrim: IMAGE_FULL_TOKENS,
					stubbable: true,
					bytes: 0,
				});
				imageIdx++;
			}
		}
		return out;
	}
	return [];
}

/** 全 wire → part 列表（每次全量提取：见 types.ts EvapState 注——emitContext 每次 clone，
 * 对象键缓存零收益；全量扫描成本毫秒级） */
function extractParts(messages: EvapWireMessage[], config: EvapConfig): EvapPartInfo[] {
	const out: EvapPartInfo[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		for (const p of extractMessageParts(msg, i, config)) out.push(p);
	}
	return out;
}

// ---------- 状态解析 ----------

type ResolvedLevel = "full" | EvapLevel;

function resolveLevel(info: EvapPartInfo, decisions: EvapDecisionMap): ResolvedLevel {
	const d = decisions.get(info.key);
	return d ? d.level : "full";
}

/** 各状态 token（userText 的 snip = fold；assistantText 的 snip = trim） */
function tokensForLevel(info: EvapPartInfo, level: ResolvedLevel): number {
	switch (level) {
		case "snip":
			if (info.cls === "userText") return info.tFold;
			if (info.cls === "assistantText") return info.tTrim;
			return info.tSnip;
		case "stub":
			return info.tStub;
		default:
			return info.tFull;
	}
}

/** 决策只升不降 */
function raiseDecision(decisions: EvapDecisionMap, key: string, level: EvapLevel): void {
	const d = decisions.get(key);
	if (!d) decisions.set(key, { level });
	else if (level === "stub" && d.level === "snip") d.level = "stub";
}

// ---------- 渲染（stub/snip 文本 = part 的纯函数；v1 中文短句，无 XML 形态） ----------

function kb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)}KB`;
}

function firstLineOf(text: string): string {
	return text.split("\n")[0] ?? "";
}

/** read 类 Tier 1：头 10 行 + 标记 + 尾 5 行 */
function renderReadSnip(text: string): string {
	const lines = text.split("\n");
	const head = lines.slice(0, READ_HEAD);
	const tail = lines.slice(-READ_TAIL);
	const cut = lines.length - head.length - tail.length;
	return `${head.join("\n")}\n…（已截断 ${cut} 行，共 ${lines.length} 行，需要时可用相同参数重读）\n${tail.join("\n")}`;
}

/** command/external 类 Tier 1：头 headLines + 标记 + 尾 tailLines（external 头部自带标题/首行） */
function renderCmdSnip(text: string, config: EvapConfig, external: boolean): string {
	const lines = text.split("\n");
	const head = lines.slice(0, config.headLines);
	const tail = lines.slice(-config.tailLines);
	const cut = lines.length - head.length - tail.length;
	const hint = external ? "需要时可用相同参数重新获取" : "完整输出可用相同命令重跑";
	return `${head.join("\n")}\n…（已截断 ${cut} 行，共 ${lines.length} 行，${hint}）\n${tail.join("\n")}`;
}

/** read 类 Tier 2 stub（spec §6 模板） */
function renderReadStub(text: string): string {
	const lines = text.split("\n");
	return `[输出已淘汰：${kb(text.length)} / ${lines.length} 行。需要时用相同参数重读即可恢复]`;
}

/** command 类 Tier 2 stub：尾 5 行原文 + 标记（spec §6 模板） */
function renderCmdStub(text: string): string {
	const lines = text.split("\n");
	const tail = lines.slice(-STUB_TAIL);
	return `${tail.join("\n")}\n[以上为尾部输出，完整 ${lines.length} 行 / ${kb(text.length)} 已淘汰，可用相同命令重跑获取]`;
}

/** external 类 Tier 2 stub：保留标题/首行 + 来源提示（spec §6 模板；非 webfetch 措辞微调） */
function renderExternalStub(text: string, toolName: string | undefined): string {
	const first = firstLineOf(text);
	if (toolName === "webfetch") {
		return `[输出已淘汰：${kb(text.length)}。标题/首行：“${first}”。URL 见上方调用参数，可重新 fetch（内容可能已变化）]`;
	}
	return `[输出已淘汰：${kb(text.length)}。首行：“${first}”。可用相同参数重新调用获取]`;
}

/** editWrite 类 Tier 2 stub：尾 5 行 + 标记（恢复方式 = 重读文件） */
function renderEditWriteStub(text: string): string {
	const lines = text.split("\n");
	const tail = lines.slice(-STUB_TAIL);
	return `${tail.join("\n")}\n[以上为尾部输出，完整 ${lines.length} 行 / ${kb(text.length)} 已淘汰，需要时可用相同参数重读文件]`;
}

/** toolResult 文本 part → 替换文本（按类 + 级别；调用前提：决策存在，即对应尺寸 < tFull） */
function renderToolResultText(info: EvapPartInfo, level: EvapLevel, config: EvapConfig): string {
	const text = info.text ?? "";
	if (level === "snip") {
		if (info.cls === "read") return renderReadSnip(text);
		return renderCmdSnip(text, config, info.cls === "external");
	}
	switch (info.cls) {
		case "read":
			return renderReadStub(text);
		case "external":
			return renderExternalStub(text, info.toolName);
		case "editWrite":
			return renderEditWriteStub(text);
		default:
			return renderCmdStub(text);
	}
}

/** 图片占位（arch §6 措辞；灰度期按 spec §15.1 统计调整） */
export const IMAGE_STUB_TEXT = "[图片已淘汰，可用原方式重新获取]";

/** 用户文本折叠：大代码块头 5 行 + 标注，块外原文保留（原文块尾换行保留，防闭合围栏粘连） */
function renderFold(text: string): string {
	const parts = text.split("```");
	const out: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] ?? "";
		if (i % 2 === 0) {
			out.push(part);
			continue;
		}
		const lines = part.split("\n");
		if (part.length >= FOLD_BLOCK_MIN_BYTES && lines.length > 7) {
			const tailNl = part.endsWith("\n") ? "\n" : "";
			out.push(
				`${lines.slice(0, FOLD_HEAD_LINES).join("\n")}\n…（代码块已折叠，共 ${lines.length} 行）${tailNl}`,
			);
		} else {
			out.push(part);
		}
	}
	// split-join 语义还原 ``` 分隔（折叠标记行不含 ```，不会引入新分隔）
	return out.join("```");
}

/** assistant 文本截断（仅 trimAssistantText=true）：前两句 + 标记 */
function renderTrim(text: string): string {
	const sents = text.split(/(?<=[。！？.!?\n])/);
	const kept = sents.slice(0, 2).join("");
	const rest = text.length - kept.length;
	return `${kept}…（后文 ${rest} 字已省略）`;
}

// ---------- 主流程 ----------

export interface EvapCallContext {
	/** effectiveWindow = min(model.contextWindow, config.budgetTokens) */
	windowTokens: number;
	/** 真实 usage（getContextUsage().tokens）；null → 内部估算兜底（compaction 后首轮等） */
	usageTokens: number | null;
}

export interface EvapResult {
	messages: EvapWireMessage[];
	batch: EvapBatchInfo;
}

/** 二分：第一个与尾部 token 保护区相交的 part 下标（replay zoneStartIdx 同款） */
function zoneStartIdx(n: number, cum: Float64Array, window: number): number {
	const zoneStartTok = Math.max(0, (cum[n] ?? 0) - window);
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((cum[mid + 1] ?? 0) > zoneStartTok) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/**
 * 蒸发一次 context 钩子的 wire。
 *
 * @param messages 当前 wire（原始未蒸发视图，SDK 每次传入；决策在 state 里持久化）
 * @param state 决策状态（decisions 原地更新）
 * @param config 蒸发配置
 * @param ctx 窗口与真实用量（usageTokens 优先；null = 内部估算水位）
 * @returns 新 wire（无蒸发时返回原数组引用）+ 批次信息
 */
export function evaporateWire(
	messages: EvapWireMessage[],
	state: EvapState,
	config: EvapConfig,
	ctx: EvapCallContext,
): EvapResult {
	const parts = extractParts(messages, config);
	const n = parts.length;
	const decisions = state.decisions;

	// 当前状态 cum（水位/保护区/批停机共用口径）与 rawCum（节省估算）
	const cum = new Float64Array(n + 1);
	const rawCum = new Float64Array(n + 1);
	let cacheHits = 0;
	const levels: ResolvedLevel[] = new Array(n);
	for (let i = 0; i < n; i++) {
		const info = parts[i];
		if (!info) continue;
		const level = resolveLevel(info, decisions);
		levels[i] = level;
		if (level !== "full") cacheHits++;
		cum[i + 1] = (cum[i] ?? 0) + tokensForLevel(info, level);
		rawCum[i + 1] = (rawCum[i] ?? 0) + info.tFull;
	}
	const rebuildCum = () => {
		for (let i = 0; i < n; i++) {
			const info = parts[i];
			if (!info) continue;
			const level = resolveLevel(info, decisions);
			levels[i] = level;
			cum[i + 1] = (cum[i] ?? 0) + tokensForLevel(info, level);
		}
	};

	// 保护区（红线，任何 Tier 不动）：尾部 protectionTokens 窗口 + 最近一次 isError toolResult
	const protIdx = new Set<number>();
	for (let i = zoneStartIdx(n, cum, config.protectionTokens); i < n; i++) protIdx.add(i);
	let lastErr = -1;
	for (let i = 0; i < n; i++) {
		if (parts[i]?.isError === true) lastErr = i;
	}
	if (lastErr >= 0) protIdx.add(lastErr);

	// 水位（usageTokens 优先，内部估算兜底——arch §2.2）
	const pct =
		ctx.usageTokens != null
			? (ctx.usageTokens / ctx.windowTokens) * 100
			: n > 0
				? ((cum[n] ?? 0) / ctx.windowTokens) * 100
				: 0;

	let tier = 0;
	if (pct >= config.tiers.snip) tier = 1;
	if (pct >= config.tiers.prune) tier = 2;

	let snipped = 0;
	let pruned = 0;

	/** 批量升级到 level，oldest-first，处理到 targetPct 下方或耗尽（replay applyBatch 同款） */
	const applyBatch = (targetPct: number, level: EvapLevel): void => {
		let tok = cum[n] ?? 0;
		for (let i = 0; i < n; i++) {
			if ((tok / ctx.windowTokens) * 100 < targetPct) break;
			const info = parts[i];
			if (!info || protIdx.has(i) || info.pinned === true) continue;
			if (level === "snip") {
				if (levels[i] === undefined || levels[i] !== "full") continue;
				let target: ResolvedLevel | null = null;
				if (info.cls === "read" && info.tSnip < info.tFull) target = "snip";
				else if (
					(info.cls === "command" || info.cls === "external") &&
					info.bytes > config.headTailThreshold &&
					info.tSnip < info.tFull
				)
					target = "snip";
				else if (info.cls === "userText" && info.tFold < info.tFull) target = "snip"; // fold
				if (!target) continue;
				tok -= tokensForLevel(info, "full") - tokensForLevel(info, target);
				raiseDecision(decisions, info.key, "snip");
				snipped++;
			} else {
				if (levels[i] === "stub") continue;
				if (info.cls !== "image" && !isToolResultCls(info.cls)) continue;
				if (!stubbableNow(info, config)) continue;
				tok -= tokensForLevel(info, levels[i] ?? "full") - info.tStub;
				raiseDecision(decisions, info.key, "stub");
				pruned++;
			}
		}
	};

	if (tier === 2) {
		// 累积执行：先 Tier 1（snip/fold），再 Tier 2（stub）
		applyBatch(config.tiers.snip - HYSTERESIS_PCT, "snip");
		rebuildCum();
		applyBatch(config.tiers.prune - HYSTERESIS_PCT, "stub");
		rebuildCum();
		if (config.trimAssistantText) {
			// replay 否决项，仅保留开关路径：留前两句 + 标记
			let tok = cum[n] ?? 0;
			for (let i = 0; i < n; i++) {
				if ((tok / ctx.windowTokens) * 100 < config.tiers.prune - HYSTERESIS_PCT) break;
				const info = parts[i];
				if (
					info?.cls !== "assistantText" ||
					levels[i] === undefined ||
					levels[i] !== "full" ||
					protIdx.has(i)
				)
					continue;
				if (info.tTrim >= info.tFull) continue;
				tok -= info.tFull - info.tTrim;
				raiseDecision(decisions, info.key, "snip"); // trim 记为 snip 级
				snipped++;
			}
			rebuildCum();
		}
	} else if (tier === 1) {
		applyBatch(config.tiers.snip - HYSTERESIS_PCT, "snip");
		rebuildCum();
	}

	// Tier 3（v1 = 无动作，SDK 原生压缩兜底；仅记录档位）
	if (n > 0 && ((cum[n] ?? 0) / ctx.windowTokens) * 100 >= config.tiers.summarize) {
		tier = 3;
	}

	// 重建 wire（未蒸发消息保持对象身份）
	const messages2 = rebuildWire(messages, parts, decisions, config);

	const wireEstTokens = n > 0 ? (cum[n] ?? 0) : 0;
	const batch: EvapBatchInfo = {
		tier,
		usagePct: pct,
		wireEstTokens,
		snipped,
		pruned,
		savedEstTokens: n > 0 ? (rawCum[n] ?? 0) - (cum[n] ?? 0) : 0,
		cacheHits,
		mapSize: decisions.size,
	};
	return { messages: messages2, batch };
}

/** Tier 2 可 stub 判定（replay stubbableNow 同款顺序：image 最先） */
function stubbableNow(info: EvapPartInfo, config: EvapConfig): boolean {
	if (info.cls === "image") return true;
	if (!info.stubbable) return false;
	if (info.cls === "editWrite") return info.bytes > config.headTailThreshold && info.tStub < info.tFull;
	if (config.tier2Scope === "gt4k" && info.bytes <= config.headTailThreshold) return false;
	return info.tStub < info.tFull;
}

/** 按决策替换消息内容；无决策的消息保持原对象，整体无蒸发时返回原数组引用 */
function rebuildWire(
	messages: EvapWireMessage[],
	parts: EvapPartInfo[],
	decisions: EvapDecisionMap,
	config: EvapConfig,
): EvapWireMessage[] {
	// 按消息分组收集有决策的 part
	const byMessage = new Map<number, EvapPartInfo[]>();
	let anyDecision = false;
	for (const p of parts) {
		const d = decisions.get(p.key);
		if (!d) continue;
		anyDecision = true;
		let arr = byMessage.get(p.messageIndex);
		if (!arr) {
			arr = [];
			byMessage.set(p.messageIndex, arr);
		}
		arr.push(p);
	}
	if (!anyDecision) return messages;

	const out = messages.slice();
	for (const [messageIndex, msgParts] of byMessage) {
		const msg = messages[messageIndex];
		if (!msg) continue;
		const role = (msg as { role?: unknown }).role;
		if (role === "user") {
			const content = msg.content;
			const copy = { ...msg } as EvapWireMessage & { content: unknown };
			if (typeof content === "string") {
				const p = msgParts.find((x) => x.kind === "userString");
				copy.content = p ? renderFold(p.text ?? "") : content;
			} else if (Array.isArray(content)) {
				copy.content = content.map((b, i) => {
					const p = msgParts.find((x) => x.blockIndex === i);
					if (!p) return b;
					if (p.kind === "userImage") return { type: "text", text: IMAGE_STUB_TEXT };
					return replaceTextBlock(b as EvapTextBlock, renderFold(p.text ?? ""));
				});
			}
			out[messageIndex] = copy;
		} else if (role === "toolResult") {
			const content = msg.content;
			if (!Array.isArray(content)) continue;
			const textPart = msgParts.find((x) => x.kind === "trText");
			const anchor = textPart ? textPart.blockIndex : -1;
			const newContent: unknown[] = [];
			for (let i = 0; i < content.length; i++) {
				const b = content[i];
				const p = msgParts.find((x) => x.blockIndex === i);
				if (p && p.kind === "trImage") {
					newContent.push({ type: "text", text: IMAGE_STUB_TEXT });
					continue;
				}
				if (textPart && isEvapTextBlock(b)) {
					// 文本 part 的替换文本落在首个 text block，其余 text block 并入淘汰
					if (i === anchor) {
						const d = decisions.get(textPart.key);
						if (d) {
							newContent.push(replaceTextBlock(b, renderToolResultText(textPart, d.level, config)));
							continue;
						}
					}
					continue; // 非锚点 text block 丢弃（内容已并入替换文本）
				}
				newContent.push(b);
			}
			out[messageIndex] = { ...msg, content: newContent } as EvapWireMessage;
		} else if (role === "assistant") {
			const content = msg.content;
			if (!Array.isArray(content)) continue;
			const copy = { ...msg } as EvapWireMessage & { content: unknown };
			copy.content = content.map((b, i) => {
				const p = msgParts.find((x) => x.blockIndex === i && x.cls === "assistantText");
				if (!p) return b;
				return replaceTextBlock(b as EvapTextBlock, renderTrim(p.text ?? ""));
			});
			out[messageIndex] = copy;
		}
	}
	return out;
}

// ---------- replay 检视（离线指标用；live 不消费） ----------

/** wire + 状态 → part 视图（与 evaporateWire 内部同源提取，顺序稳定） */
export function inspectParts(
	messages: EvapWireMessage[],
	state: EvapState,
	config: EvapConfig,
): EvapPartView[] {
	const parts = extractParts(messages, config);
	const out: EvapPartView[] = [];
	for (const info of parts) {
		const level = resolveLevel(info, state.decisions);
		out.push({
			cls: info.cls,
			key: info.key,
			toolCallId: info.toolCallId,
			isError: info.isError,
			level,
			tokens: tokensForLevel(info, level),
			tFull: info.tFull,
			tSnip: info.tSnip,
			tStub: info.tStub,
			bytes: info.bytes,
			messageIndex: info.messageIndex,
		});
	}
	return out;
}
