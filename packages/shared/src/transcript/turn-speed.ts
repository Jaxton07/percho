/**
 * 轮次 token 生成速度派生（纯函数；token 速度组件数据源）。
 *
 * 口径（三种，必须可辨——单一数字会骗人）：
 * 1. **api 口径**：speed = Σ usage.output ÷ Σ message.durationMs。
 *    分子 = API 权威输出 token 数（非文本估算）；分母 = pi SDK AssistantMessageEventStream 实测
 *    「请求发出 → 响应结束」，逐条累加 ⇒ 天然排除工具执行、排队、消息间隙。
 *    缺点：分母含 prefill（TTFT）与网络，长 prompt 轮会被显著拉低（实测本机 3440 样本：
 *    聚合 29.6 tok/s，逐条 p50 42 / p10 13——差 3 倍，差异几乎全来自 prefill 占比）。
 * 2. **decode 口径**：speed = Σ usage.output ÷ Σ (durationMs − prefillMs)，
 *    prefillMs 由渲染端实测（首个内容 delta 到达时刻 − message.timestamp）。
 *    只有「hook 挂载后live 观测到的消息」能算；历史消息无首 delta 时刻，退回 api 口径。
 * 3. **wall 口径**（不在本模块算）：output ÷ 轮 wall（deriveTurnTimings）。会把工具执行/排队
 *    计入分母——实测本机 API 时长只占轮 wall 的 15%，即稀释约 6.9×，**不作为默认展示口径**。
 *
 * 样本校验（不达标丢弃；全丢弃 → null，宁缺勿错——历史轮/缺字段轮不显示假速度）：
 * - stopReason === "error"（失败请求）跳过：重试轮的失败尝试（低输出/短耗时）会稀释速度；
 * - output 必须是有限数且 **> 0**（0 输出只增分母不增分子，是纯稀释项）；
 * - durationMs 必须是有限数且 > 0；
 * - output ≤ durationMs（等价于拒绝 >1000 tok/s 的不可信样本）。
 *
 * 轮边界与 deriveTurnTimings 同规则：user 消息为边界。取样本与切片由调用方（backend）负责。
 */

/** 单条 assistant 消息的原始字段样本（透传原始值；类型校验在 toSpeedMessage 内完成） */
export interface TurnSpeedSample {
	/** pi AssistantMessage.usage.output（缺省 = 该消息无 usage） */
	output?: unknown;
	/** pi AssistantMessage.durationMs（缺省 = 该消息未测得生成耗时） */
	durationMs?: unknown;
	/** pi AssistantMessage.stopReason（"error" = 失败请求，不计入样本） */
	stopReason?: unknown;
	/** prompt 规模 = usage.input + usage.cacheRead + usage.cacheWrite（prefill 占比的解释分量） */
	promptTokens?: unknown;
	/** pi AssistantMessage.model */
	model?: unknown;
	/** pi AssistantMessage.provider */
	provider?: unknown;
}

/** 校验后的单条 LLM 消息样本 */
export interface SpeedMessage {
	output: number;
	durationMs: number;
	promptTokens: number;
	model?: string;
	provider?: string;
}

/** 一组消息的聚合速度（speed = null ⇒ 无有效样本） */
export interface SpeedAggregate {
	outputTokens: number;
	/** Σ api 时长（ms）：含 prefill/网络，不含工具执行/排队 */
	durationMs: number;
	/** Σ prompt 规模 */
	promptTokens: number;
	/** 有效样本数（计入的 LLM 消息条数） */
	samples: number;
	speed: number | null;
}

/** 一轮的速度（turnIndex 与 deriveTurnTimings / TurnChanges 同规则，从 0 计） */
export interface SpeedTurn extends SpeedAggregate {
	turnIndex: number;
	/** 本轮最后一个有 model 的样本（tooltip 显示用） */
	model?: string;
	/** 逐条样本；仅当前轮提供（历史轮不带，控制载荷） */
	messages?: SpeedMessage[];
}

/** 全会话累计 */
export type SpeedSession = SpeedAggregate;

/** getTurnSpeed 载荷：当前轮 + 最近若干轮 + 全会话累计 */
export interface TurnSpeedSnapshot {
	/** 最后一轮（= 当前轮）；无有效样本 → null */
	current: SpeedTurn | null;
	/** 按 turnIndex 升序的轮次列表（可能被 maxTurns 截断，只保留最近的） */
	turns: SpeedTurn[];
	session: SpeedSession;
	/** turns 列表是否因 maxTurns 被截断 */
	truncated: boolean;
}

const MAX_MESSAGES_PER_TURN = 200;
const DEFAULT_MAX_TURNS = 40;

const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** 原始样本 → 校验后样本；不合格返回 null */
export function toSpeedMessage(sample: TurnSpeedSample): SpeedMessage | null {
	if (sample.stopReason === "error") return null;
	const { output, durationMs } = sample;
	if (!finiteNumber(output) || output <= 0) return null;
	if (!finiteNumber(durationMs) || durationMs <= 0) return null;
	// 拒绝 >1000 tok/s：物理上不可信（durationMs 退化/字段错位）
	if (output > durationMs) return null;
	const promptTokens = finiteNumber(sample.promptTokens) && sample.promptTokens > 0 ? sample.promptTokens : 0;
	return {
		output,
		durationMs,
		promptTokens,
		...(typeof sample.model === "string" && sample.model ? { model: sample.model } : {}),
		...(typeof sample.provider === "string" && sample.provider ? { provider: sample.provider } : {}),
	};
}

/** 校验后样本组 → 聚合速度（空组 → speed null） */
export function aggregateSpeed(messages: readonly SpeedMessage[]): SpeedAggregate {
	let outputTokens = 0;
	let durationMs = 0;
	let promptTokens = 0;
	for (const message of messages) {
		outputTokens += message.output;
		durationMs += message.durationMs;
		promptTokens += message.promptTokens;
	}
	return {
		outputTokens,
		durationMs,
		promptTokens,
		samples: messages.length,
		speed: messages.length > 0 && durationMs > 0 ? outputTokens / (durationMs / 1000) : null,
	};
}

/** 逐轮原始样本（轮序 = turnIndex 升序）→ 快照；无 user 边界的前置消息由调用方剔除 */
export function deriveTurnSpeed(
	turnsSamples: readonly (readonly TurnSpeedSample[])[],
	options: { maxTurns?: number; maxMessages?: number } = {},
): TurnSpeedSnapshot {
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	const maxMessages = options.maxMessages ?? MAX_MESSAGES_PER_TURN;
	const turns: SpeedTurn[] = [];
	const all: SpeedMessage[] = [];
	// 逐条明细只挂到最后一个有样本的轮（= 当前轮）：tooltip 与 decode 拆分需要明细，历史轮不带以控载荷
	let lastMessages: SpeedMessage[] = [];
	for (let turnIndex = 0; turnIndex < turnsSamples.length; turnIndex++) {
		const messages: SpeedMessage[] = [];
		for (const raw of turnsSamples[turnIndex] ?? []) {
			const message = toSpeedMessage(raw);
			if (!message) continue;
			messages.push(message);
			all.push(message);
		}
		const aggregate = aggregateSpeed(messages);
		if (aggregate.samples === 0) continue; // 无有效样本的轮不进入列表（宁缺勿错）
		const model = messages.findLast((message) => message.model !== undefined)?.model;
		turns.push({ turnIndex, ...aggregate, ...(model ? { model } : {}) });
		lastMessages = messages.slice(-maxMessages);
	}
	const lastTurn = turns[turns.length - 1];
	if (lastTurn) lastTurn.messages = lastMessages;
	const truncated = turns.length > maxTurns;
	const kept = truncated ? turns.slice(-maxTurns) : turns;
	return {
		current: kept.length > 0 ? (kept[kept.length - 1] ?? null) : null,
		turns: kept,
		session: aggregateSpeed(all),
		truncated,
	};
}

/* ---------- decode 口径（渲染端 TTFT 实测 → 拆分 prefill/decode） ---------- */

/** 一条消息的 prefill/decode 拆分结果 */
export interface SpeedSplit {
	/** 请求发出 → 首个内容 delta（含网络与 prefill） */
	prefillMs: number;
	/** durationMs − prefillMs：纯生成窗口 */
	decodeMs: number;
}

/**
 * 拆分单条：ttftMs = 渲染端观测的（首个内容 delta 到达 − message.timestamp）。
 * 不可用条件：缺观测、时钟负值（跨机器/远程环境时钟偏移）、观测 ≥ 总时长（无生成窗口）。
 */
export function splitPrefillDecode(
	message: SpeedMessage,
	ttftMs: number | null | undefined,
): SpeedSplit | null {
	if (!finiteNumber(ttftMs)) return null;
	if (ttftMs < 0 || ttftMs >= message.durationMs) return null;
	return { prefillMs: ttftMs, decodeMs: message.durationMs - ttftMs };
}

/** decode 口径聚合结果：covered = 参与拆分的消息数；prefillMs = 这些消息的 Σ prefill */
export interface DecodeAggregate extends SpeedAggregate {
	covered: number;
	prefillMs: number;
}

/** decode 口径聚合：只统计能拆分的消息；无一能拆分 → null（调用方退回 api 口径） */
export function aggregateDecode(
	messages: readonly SpeedMessage[],
	ttftMs: readonly (number | null)[],
): DecodeAggregate | null {
	let outputTokens = 0;
	let decodeMs = 0;
	let prefillMs = 0;
	let covered = 0;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const split = message === undefined ? null : splitPrefillDecode(message, ttftMs[i]);
		if (!split || !message) continue;
		outputTokens += message.output;
		decodeMs += split.decodeMs;
		prefillMs += split.prefillMs;
		covered++;
	}
	if (covered === 0 || decodeMs <= 0) return null;
	return {
		outputTokens,
		durationMs: decodeMs,
		promptTokens: messages.reduce((sum, message) => sum + message.promptTokens, 0),
		samples: covered,
		speed: outputTokens / (decodeMs / 1000),
		covered,
		prefillMs,
	};
}

/* ---------- 渲染端视图组装（纯函数：后端快照 + TTFT 观测 + live 估算） ---------- */

/** live 估算的内部状态（流式期间的 token 计数与滚动窗口速率） */
export interface LiveEstimate {
	tokens: number;
	speed: number;
}

/**
 * 渲染端视图：`metric`/`speed` = 展示口径（有 decode 用 decode，否则 api）；
 * 两个口径都给出，组件必须标注——api 含 prefill/网络，长 prompt 轮可低 30%+。
 */
export interface TurnSpeedView {
	/** 展示口径：decode = 已用实测 TTFT 剔除 prefill；api = 含 prefill/网络 */
	metric: "decode" | "api";
	/** metric 对应的速度（tok/s） */
	speed: number;
	/** api 口径（Σ output ÷ Σ durationMs；含 prefill，不含工具执行/排队） */
	apiSpeed: number | null;
	/** decode 口径（Σ output ÷ Σ (durationMs − 实测 prefill)）；无观测 → null */
	decodeSpeed: number | null;
	/** metric 口径的分子（token）与分母（ms） */
	outputTokens: number;
	durationMs: number;
	/** 当前轮 Σ api 时长；Σ 实测 prefill（null = 本轮无可拆分样本） */
	apiMs: number;
	prefillMs: number | null;
	/** 当前轮 Σ prompt 规模（tooltip 解释 prefill 占比） */
	promptTokens: number;
	/** metric 口径计入的 LLM 消息条数 */
	samples: number;
	model?: string;
	/** 本轮是否仍在生成 */
	live: boolean;
	/** 流式期间累计估算 token（非权威值） */
	liveTokens: number | null;
	/** 流式期间滚动窗口速率（估算 tok/s） */
	liveSpeed: number | null;
	/** 最近若干轮（含当前轮） */
	turns: SpeedTurn[];
	/** 全会话累计 */
	session: SpeedAggregate;
}

/**
 * 后端快照 + TTFT 观测 + live 估算 → 组件视图。
 * 尾部对齐：观测只覆盖 hook 挂载后 live 看到的消息，它们排在后端 messages 末尾。
 */
export function buildTurnSpeedView(
	snapshot: TurnSpeedSnapshot | null,
	ttftMs: readonly (number | null)[],
	live: LiveEstimate | null,
): TurnSpeedView | null {
	if (!snapshot) return null;
	const current = snapshot.current;
	const messages = current?.messages ?? [];
	const take = Math.min(messages.length, ttftMs.length);
	const decode = take > 0 ? aggregateDecode(messages.slice(-take), ttftMs.slice(-take)) : null;

	// 本轮无权威样本（新轮刚开始 / 全是失败尝试）：只有 live 估算时给纯 live 视图
	if (!current || current.speed === null) {
		if (!live) return null;
		return {
			metric: "api",
			speed: live.speed,
			apiSpeed: snapshot.session.speed,
			decodeSpeed: null,
			outputTokens: Math.round(live.tokens),
			durationMs: 0,
			apiMs: 0,
			prefillMs: null,
			promptTokens: 0,
			samples: 0,
			live: true,
			liveTokens: Math.round(live.tokens),
			liveSpeed: live.speed,
			turns: snapshot.turns,
			session: snapshot.session,
		};
	}

	const useDecode = decode !== null && decode.speed !== null;
	const shown = useDecode ? decode : current;
	return {
		metric: useDecode ? "decode" : "api",
		speed: shown.speed ?? current.speed,
		apiSpeed: current.speed,
		decodeSpeed: decode?.speed ?? null,
		outputTokens: shown.outputTokens,
		durationMs: shown.durationMs,
		apiMs: current.durationMs,
		prefillMs: decode?.prefillMs ?? null,
		promptTokens: current.promptTokens,
		samples: shown.samples,
		...(current.model ? { model: current.model } : {}),
		live: live !== null,
		liveTokens: live ? Math.round(live.tokens) : null,
		liveSpeed: live ? live.speed : null,
		turns: snapshot.turns,
		session: snapshot.session,
	};
}

/** CJK/假名/谚文/西里尔 ≈ 1 字符/token；其余 ≈ 4 字符/token（仅用于流式期间的瞬时指示，非权威值） */
const CJK_PATTERN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/g;

/** 流式片段（正文/思考/工具参数）→ 估算 token 数 */
export function estimateStreamingTokens(parts: readonly string[]): number {
	let total = 0;
	let cjk = 0;
	for (const part of parts) {
		if (!part) continue;
		const found = part.match(CJK_PATTERN);
		const partCjk = found ? found.length : 0;
		total += part.length;
		cjk += partCjk;
	}
	return (total - cjk) / 4 + cjk;
}
