/**
 * 摘要输入有界化（spec D3）——各层规则见 `.local/agent-work/spec/compaction-bounded.md`。
 *
 * 层 1（降级，便宜）：**保护区外**把
 * - `thinking` 正文 → 一行占位 `[思考已省略 N 字符]`；
 * - `toolCall.arguments` → 只留白名单字段（各截 200 字符）+ `_omitted` 省略说明；
 * - `toolResult` 文本 → 头 5 行 + 尾 3 行，上限 `toolResultChars`（默认 300；SDK 自己只截到 2000）；
 * 其余（user / assistant 正文、图片等）**原样**。
 *
 * 层 2（硬上限，收敛口径 = **整体估算**）：
 * - 先用**逐条估算求和**做廉价初判（全量序列化要 1–2 秒，不该每次压缩都白付）；
 * - 仅当 `cheap > cap × 0.85` 才整体序列化 + 迭代丢弃（每轮至少再丢 1 条，最多 8 轮），插一行省略标记；
 * - 单条消息自身就超 cap → 对该条内部再收紧一次（保护区让位；连纯文本块也截，M2）；
 *   仍不行 → 交回**已知最小的那一版**（不是原样，M1：请求越小越可能成功；残余风险见 spec §5）。
 *
 * 纪律：
 * - 零 SDK / 零仓库 import：序列化器（SDK `serializeConversation ∘ convertToLlm`）由调用方**注入**，
 *   离线重放脚本因此能 import 同一份实现（单一事实源）。
 * - 结果必然是**新数组 + 新消息对象**，绝不就地修改入参（`preparation.messagesToSummarize`
 *   与 SDK 默认摘要路径共享引用，见 spec §2）。
 */

import { estimateTokens } from "./estimate";
import type { CompactionBoundResult, CompactionBoundStats, GuardContentBlock, GuardMessage } from "./types";

// ---------- 常量（层 1 规则） ----------

/** thinking 占位（保留原字符数，便于摘要上下文里判断“这里曾有思考”）；同时用于识别“已降级过” */
const THINKING_PLACEHOLDER_PREFIX = "[思考已省略 ";
const thinkingPlaceholder = (chars: number): string => `${THINKING_PLACEHOLDER_PREFIX}${chars} 字符]`;
const isThinkingPlaceholder = (text: string): boolean => text.startsWith(THINKING_PLACEHOLDER_PREFIX);

/** toolCall 参数白名单：摘要只需要「动了哪个文件 / 跑了什么命令」，不要正文 */
const ARG_WHITELIST = ["path", "file_path", "command", "pattern", "url", "query", "glob", "name", "agent"];
/** 白名单字段各截多少字符 */
const ARG_VALUE_CHARS = 200;
/** toolResult 文本保留的头/尾行数 */
const TOOL_RESULT_HEAD_LINES = 5;
const TOOL_RESULT_TAIL_LINES = 3;
/** 层 2 迭代上限（spec D3） */
const MAX_CAP_ROUNDS = 8;
/** 廉价初判门槛：`cheap > cap × 该比例` 才做整体序列化（逐条口径系统性低估 0.4–0.6%，留足余量） */
const CHEAP_TRIGGER_RATIO = 0.85;
/** 二次收紧（单条自身超 cap）时的更小上限 */
const OVERSIZED_TEXT_CHARS = 80;

export const TURN_START_ROLES = new Set([
	"user",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

// ---------- 保护区 ----------

/**
 * 保护区起点 = 最近 `protectTurns` 个「轮起点」消息的下标；`messages.length` 表示不保护。
 *
 * 「轮起点」判定**复刻 SDK**（`core/compaction/compaction.js` 的 `isTurnStartMessage`，未导出）：
 * role ∈ {user, bashExecution, custom, branchSummary, compactionSummary}。这条复刻由 A6③ 钉住。
 */
export function protectionStart(messages: GuardMessage[], protectTurns: number): number {
	if (protectTurns <= 0) return messages.length;
	const starts: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message && TURN_START_ROLES.has(message.role)) starts.push(i);
	}
	if (starts.length <= protectTurns) return 0;
	return starts[starts.length - protectTurns] ?? 0;
}

// ---------- 层 1：降级 ----------

export interface DegradeStats {
	degradedMessages: number;
	thinkingChars: number;
	argChars: number;
	toolResultChars: number;
	/** 二次收紧（单条超 cap）被截短的消息条数 */
	secondPass: number;
}

const omissionNote = (shaved: number): string => `…（已省略 ${shaved} 字符）`;

/** 头 N 行 + 尾 M 行 + 省略标记；**结果长度恒 ≤ maxChars** */
function truncateToolText(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	const lines = text.split("\n");
	const head = lines.slice(0, TOOL_RESULT_HEAD_LINES).join("\n");
	const tail = lines.slice(-TOOL_RESULT_TAIL_LINES).join("\n");
	let out = `${head}\n…\n${tail}`;
	if (out.length > maxChars) out = out.slice(0, Math.max(0, maxChars - 14)); // 给省略标记留位置
	out = `${out}${omissionNote(Math.max(0, text.length - out.length))}`;
	return out.length <= maxChars ? out : out.slice(0, maxChars);
}

/** 参数降级：白名单字段（字符串截断、其他值 JSON 化后截断）+ 省略说明 */
export function degradeArguments(
	args: Record<string, unknown> | undefined,
	limit: number,
	/** 二次收紧：只留第一个命中的白名单字段 */
	strict = false,
): Record<string, unknown> {
	const kept: Record<string, unknown> = {};
	let took = false;
	for (const key of ARG_WHITELIST) {
		const value = args?.[key];
		if (value === undefined || value === null || (strict && took)) continue;
		if (typeof value === "string") kept[key] = value.length <= limit ? value : value.slice(0, limit);
		else kept[key] = JSON.stringify(value).slice(0, limit);
		took = true;
	}
	const beforeChars = JSON.stringify(args ?? {}).length;
	kept._omitted = omissionNote(Math.max(0, beforeChars - JSON.stringify(kept).length));
	return kept;
}

/**
 * 层 1：保护区外降级，返回**新数组**（未改动的消息复用原对象——它们不会被就地修改）。
 * `strict` = 二次收紧（单条自身超 cap 时用更小的文本上限 + 参数只留一个字段）。
 * `strictIndices` = 指定下标**无视保护区**也要降级：单条消息自身就超过整个 cap 时，
 * 保护区让位（否则这条留着必然超限，整份输入只能原样退回 SDK，等于这块会话永远无界）。
 */
export function degradeLayer1(
	messages: GuardMessage[],
	options: { protectTurns: number; toolResultChars: number; strict?: boolean; strictIndices?: number[] },
): { messages: GuardMessage[]; stats: DegradeStats } {
	const strict = options.strict === true;
	const protectFrom = protectionStart(messages, options.protectTurns);
	const textLimit = strict ? OVERSIZED_TEXT_CHARS : options.toolResultChars;
	const stats: DegradeStats = {
		degradedMessages: 0,
		thinkingChars: 0,
		argChars: 0,
		toolResultChars: 0,
		secondPass: 0,
	};

	const forced = new Set(options.strictIndices ?? []);
	const out = messages.map((message, index) => {
		const isForced = forced.has(index);
		if (index >= protectFrom && !isForced) return message;
		const content = message.content;
		if (!Array.isArray(content)) return message;
		let touched = false;
		const blocks = content.map((block) => {
			if (
				block.type === "thinking" &&
				typeof block.thinking === "string" &&
				block.thinking.length > 0 &&
				!isThinkingPlaceholder(block.thinking)
			) {
				const placeholder = thinkingPlaceholder(block.thinking.length);
				stats.thinkingChars += block.thinking.length - placeholder.length;
				touched = true;
				return { ...block, thinking: placeholder } satisfies GuardContentBlock;
			}
			if (block.type === "toolCall" && block.arguments !== undefined) {
				const beforeChars = JSON.stringify(block.arguments ?? {}).length;
				const args = degradeArguments(
					block.arguments as Record<string, unknown>,
					strict ? OVERSIZED_TEXT_CHARS : ARG_VALUE_CHARS,
					strict,
				);
				stats.argChars += Math.max(0, beforeChars - JSON.stringify(args).length);
				touched = true;
				return { ...block, arguments: args } satisfies GuardContentBlock;
			}
			// M2：二次收紧时**纯文本块**（user 长文档 / assistant 正文）也要截——只针对「自身就超 cap」的那几条（`isForced`），
			// 否则会把历史里正常长度的用户消息也切掉（它们不超限，没必要动）
			if (
				isForced &&
				strict &&
				message.role !== "toolResult" &&
				typeof block.text === "string" &&
				block.text.length > textLimit
			) {
				const text = truncateToolText(block.text, textLimit);
				stats.toolResultChars += block.text.length - text.length;
				stats.secondPass++;
				touched = true;
				return { ...block, text } satisfies GuardContentBlock;
			}
			if (
				message.role === "toolResult" &&
				typeof block.text === "string" &&
				textLimit > 0 &&
				block.text.length > textLimit
			) {
				const text = truncateToolText(block.text, textLimit);
				if (text !== block.text) {
					stats.toolResultChars += block.text.length - text.length;
					if (strict) stats.secondPass++;
					touched = true;
					return { ...block, text } satisfies GuardContentBlock;
				}
			}
			return block;
		});
		if (!touched) return message;
		stats.degradedMessages++;
		return { ...message, content: blocks };
	});
	return { messages: out, stats };
}

// ---------- 体积测量 ----------

/** 逐条估算求和（廉价；系统性低估 0.4–0.6%，只用于初判） */
export function cheapEstimate(messages: GuardMessage[], serialize: (m: GuardMessage[]) => string): number {
	let total = 0;
	for (const message of messages) total += estimateTokens(serialize([message]));
	return total;
}

/** 整体序列化后估算（**收敛口径**，也是 A3 断言的量） */
export function exactEstimate(messages: GuardMessage[], serialize: (m: GuardMessage[]) => string): number {
	return estimateTokens(serialize(messages));
}

/** cap 是否介入（`<= 0` / 非有限值 = 不介入，原样交回 SDK） */
export function capActive(cap: number): boolean {
	return Number.isFinite(cap) && cap > 0;
}

// ---------- 层 2 + 主入口 ----------

export interface BoundOptions {
	/** 生效上限（token）；`<= 0` / 非有限值 = 不介入 */
	cap: number;
	/** 保护区：最近 N 个用户轮不降级 */
	protectTurns: number;
	/** 降级后单条 tool result 文本上限（字符）；`<= 0` = 不动 toolResult */
	toolResultChars: number;
	/** 序列化器（SDK 同源，注入以保持本模块零 SDK import） */
	serialize: (messages: GuardMessage[]) => string;
}

/** 「更早的 N 条消息已省略」标记（层 2 丢消息时插一行，让摘要知道前面还有内容） */
export function droppedMarker(dropped: number): GuardMessage {
	return { role: "user", content: [{ type: "text", text: `[更早的 ${dropped} 条消息已省略]` }] };
}

/** 从最旧开始整条丢弃，直到逐条口径 ≤ target（`forceOne` 时至少丢 1 条，保证迭代有进展） */
function dropUntilCheapBelow(
	messages: GuardMessage[],
	target: number,
	serialize: (m: GuardMessage[]) => string,
	forceOne: boolean,
): number {
	const sizes = messages.map((message) => estimateTokens(serialize([message])));
	let total = sizes.reduce((a, b) => a + b, 0);
	let dropped = 0;
	while (dropped < messages.length && (total > target || (forceOne && dropped === 0))) {
		total -= sizes[dropped] ?? 0;
		dropped++;
	}
	return dropped;
}

/**
 * 被降级（换成了新对象）的消息条数：按**对象身份**数，避免「层 1 与二次收紧都改了同一条」被重复计数。
 * 传入的都是「最终交回的那一版」。
 */
function countDegraded(original: GuardMessage[], result: GuardMessage[]): number {
	const originalObjects = new Set(original);
	let count = 0;
	for (const message of result) if (!originalObjects.has(message)) count++;
	return count;
}

/** 自身估算就超 cap 的消息（下标 + 条数）：既要当残余风险指标，也要据此做二次收紧 */
function oversizedIndices(
	messages: GuardMessage[],
	cap: number,
	serialize: (m: GuardMessage[]) => string,
): number[] {
	const out: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message && estimateTokens(serialize([message])) > cap) out.push(i);
	}
	return out;
}

function makeStats(partial: Partial<CompactionBoundStats> & { messageCount: number }): CompactionBoundStats {
	return {
		degradedMessages: 0,
		droppedMessages: 0,
		estimatedBefore: 0,
		estimatedAfter: 0,
		cap: 0,
		withinCap: true,
		oversizedMessages: 0,
		measure: "cheap",
		capRounds: 0,
		...partial,
	};
}

export function boundMessages(messages: GuardMessage[], options: BoundOptions): CompactionBoundResult {
	const { serialize } = options;
	const messageCount = messages.length;

	// cap 不介入（极端小窗口）：原样交回 SDK
	if (!capActive(options.cap)) {
		const estimate = cheapEstimate(messages, serialize);
		return {
			messages,
			stats: makeStats({
				messageCount,
				estimatedBefore: estimate,
				estimatedAfter: estimate,
				cap: options.cap,
				withinCap: true,
			}),
		};
	}

	const before = cheapEstimate(messages, serialize);
	const layer1 = degradeLayer1(messages, {
		protectTurns: options.protectTurns,
		toolResultChars: options.toolResultChars,
	});
	const cheapAfter = cheapEstimate(layer1.messages, serialize);

	// 廉价初判：远低于 cap 就不付整体序列化的代价（spec D3 两段式）
	if (cheapAfter <= options.cap * CHEAP_TRIGGER_RATIO) {
		return {
			messages: layer1.messages,
			stats: makeStats({
				messageCount,
				degradedMessages: countDegraded(messages, layer1.messages),
				estimatedBefore: before,
				estimatedAfter: cheapAfter,
				cap: options.cap,
				withinCap: cheapAfter <= options.cap,
				measure: "cheap",
			}),
		};
	}

	// 层 2：整体估算 + 迭代丢弃（每轮至少丢 1 条；**至少留一条**——全丢光等于没有可摘要的内容）
	let kept = layer1.messages;
	let dropped = 0;
	let rounds = 0;
	let current = kept;
	let exact = exactEstimate(current, serialize);
	while (exact > options.cap && rounds < MAX_CAP_ROUNDS) {
		const droppable = kept.length - 1;
		if (droppable <= 0) break;
		const dropCount = Math.min(
			dropUntilCheapBelow(kept, options.cap * CHEAP_TRIGGER_RATIO, serialize, rounds > 0),
			droppable,
		);
		if (dropCount === 0) break;
		kept = kept.slice(dropCount);
		dropped += dropCount;
		rounds++;
		current = [droppedMarker(dropped), ...kept]; // 标记也参与整体估算（可能要再丢一轮）
		exact = exactEstimate(current, serialize);
	}

	// 单条消息自身超 cap：对这一条按层 1 粒度再收紧一次（**保护区让位**，见 degradeLayer1 注释）
	let oversizedList = oversizedIndices(current, options.cap, serialize);
	if (oversizedList.length > 0) {
		const strict = degradeLayer1(current, {
			protectTurns: options.protectTurns,
			toolResultChars: options.toolResultChars,
			strict: true,
			strictIndices: oversizedList,
		});
		const strictExact = exactEstimate(strict.messages, serialize);
		if (strictExact < exact) {
			current = strict.messages;
			exact = strictExact;
		}
		oversizedList = oversizedIndices(current, options.cap, serialize);
	}

	// 仍超 cap：交回**已知最小的那一版**（M1：返回原样在任何情况下都不会更好），只记 trace（spec §5）
	if (oversizedList.length > 0 && exact > options.cap) {
		return {
			messages: current,
			stats: makeStats({
				messageCount,
				degradedMessages: countDegraded(messages, current),
				droppedMessages: dropped,
				estimatedBefore: before,
				estimatedAfter: exact,
				cap: options.cap,
				withinCap: false,
				oversizedMessages: oversizedList.length,
				measure: "exact",
				capRounds: rounds,
			}),
		};
	}

	return {
		messages: current,
		stats: makeStats({
			messageCount,
			degradedMessages: countDegraded(messages, current),
			droppedMessages: dropped,
			estimatedBefore: before,
			estimatedAfter: exact,
			cap: options.cap,
			withinCap: exact <= options.cap,
			oversizedMessages: oversizedList.length,
			measure: "exact",
			capRounds: rounds,
		}),
	};
}
