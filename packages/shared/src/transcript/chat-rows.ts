import type { TurnChanges } from "./turn-files";
import type { TurnTiming } from "./turn-timings";
import type { ActivityEntry, SessionTranscriptState, SubagentRunUi, UIMessage, UIToolCall } from "./types";

/**
 * 聊天行构建（transcript → 渲染行序列）：桌面 MessageList 与 lan-web ChatView 共享的
 * 「分组大脑」。纯函数、零 React/DOM——两端各自把行模型映射成自己的渲染壳。
 *
 * 合并规则：assistant 消息的思考/工具并入折叠组，正文（text）是边界——正文出现时组关闭、
 * 正文作为独立行；子代理结果先落所属折叠状态行再紧跟卡片。
 */

/** 折叠组中的一条元数据项（一条消息的思考/工具，或流式中的进行中部分） */
export interface MetaItem {
	thinking: string;
	tools: UIToolCall[];
	/** 流式项的活动序列（到达顺序），预览行数据源；仅流式（未提交）项携带 */
	activity?: ActivityEntry[];
}

export type ChatRow =
	| {
			kind: "metaGroup";
			key: string;
			items: MetaItem[];
			/** 仅当前 run 的组接收 working 信号（历史组恒为已完成） */
			working: boolean;
			/** 正文在输出或 run 已终结 → working 消失时立即结束，不做滞后缓冲 */
			endImmediately: boolean;
			subagentCount: number;
	  }
	| {
			kind: "message";
			key: string;
			message: UIMessage;
			/** 思考/工具已并入折叠组（渲染时不再重复展示） */
			metaInGroup: boolean;
			/** 轮次末段正文挂操作行（复制/fork） */
			showActions: boolean;
			/** 流式正文占位（固化后同 id 进入 messages，不 remount） */
			streaming: boolean;
	  }
	| { kind: "streamingSubagents"; key: string; runs: SubagentRunUi[] }
	| {
			kind: "turnDiff";
			key: string;
			/** 轮末文件变更（有变更才有；timer 行可无 diff） */
			changes?: TurnChanges;
			/** 轮次计时（桌面路径必有；lan-web 不传则行只在有 changes 时出现） */
			timing?: TurnTiming;
			/** 最后一轮且 agent 运行中（桌面包装层样式用；timer 跳动信号） */
			running: boolean;
			/** 前一行是折叠组（组自带 -mb-4，chip 不再上提） */
			afterMetaGroup: boolean;
			/** 本会话查看期间新完成的最后一轮（进场动画） */
			entering: boolean;
	  };

/**
 * agentWorking：agent 运行中且正文未出现 → 折叠组标题 working；
 * 正文已出但工具/子代理还在跑时不熄灯（执行发生在 message_end 之后、turn_end 之前）。
 */
export function isAgentWorking(transcript: SessionTranscriptState): boolean {
	const streaming = transcript.streaming;
	const hasRunningWork = Boolean(
		streaming?.tools.some((t) => t.state === "running") ||
			streaming?.subagentRuns.some((r) => r.status === "running"),
	);
	return transcript.agentActive && (!streaming?.text || hasRunningWork);
}

/**
 * 已提交消息的 MetaItem 缓存（WeakMap，键 = 消息对象）：
 * 历史 MessageList 每次渲染都重跑 buildChatRows，若 items 里的元素每次都是新字面量，
 * MetaGroup 的 memo 比较器会永远失败 → 历史折叠组随每条流式 delta 全量重渲染
 * （重建 ToolCallCard 元素 + summarizeArgs 正则，随历史长度线性放大）。
 * 消息对象不可变（替换必新建对象），以对象身份为键安全；loadHistory 重建 → 新键、旧项 GC。
 */
const committedMetaCache = new WeakMap<Extract<UIMessage, { kind: "assistant" }>, MetaItem>();
function committedMetaItem(message: Extract<UIMessage, { kind: "assistant" }>): MetaItem {
	let item = committedMetaCache.get(message);
	if (!item) {
		item = { thinking: message.thinking, tools: message.tools };
		committedMetaCache.set(message, item);
	}
	return item;
}

export interface TurnDiffRowsOptions {
	/** 每轮文件变更（桌面 deriveTurnChanges 产出；不传 = 无 timer 时行退化为有变更才出现，lan-web 路径） */
	turnChanges?: TurnChanges[];
	/** 每轮计时（桌面 deriveTurnTimings 产出；不传 = 不产 timer 行） */
	turnTimings?: TurnTiming[];
	/** 进场动画目标轮（桌面 MessageList 的 baseline 逻辑算出） */
	enteringTurn?: number | null;
}

export function buildChatRows(
	transcript: SessionTranscriptState,
	sessionId: string,
	now: number = Date.now(),
	opts?: TurnDiffRowsOptions,
): ChatRow[] {
	const { streaming } = transcript;
	const agentWorking = isAgentWorking(transcript);
	const rows: ChatRow[] = [];
	let metaItems: MetaItem[] = [];

	/**
	 * 轮次末段正文 id 集合：以 user 消息为轮次边界，每轮（agent 一次回复）只给最后一段正文
	 * 挂操作行——中间多段是工具循环里的自言自语，全部挂按钮噪音太大。
	 * agentActive 期间本轮尚未定稿，末段先不挂（agent_end 后自然出现）。
	 */
	const turnFinalTextIds = new Set<string>();
	let lastTextId: string | null = null;
	for (const message of transcript.messages) {
		if (message.kind === "user") {
			if (lastTextId) turnFinalTextIds.add(lastTextId);
			lastTextId = null;
			continue;
		}
		if (message.kind === "assistant" && message.text) lastTextId = message.id;
	}
	if (!transcript.agentActive && lastTextId) turnFinalTextIds.add(lastTextId);

	/** 组序号：同会话内 key 按位置稳定（streaming→committed 转换不 remount）；key 含会话 id：切会话强制 remount */
	let groupIndex = 0;
	const flushMeta = (isLatest = false, forceEmpty = false, subagentCount = 0): void => {
		if (metaItems.length === 0 && !forceEmpty && subagentCount === 0) return;
		const endImmediately = Boolean(streaming?.text) || !transcript.agentActive;
		rows.push({
			kind: "metaGroup",
			key: `meta-${sessionId}-g${groupIndex++}`,
			items: metaItems,
			working: isLatest && agentWorking,
			endImmediately,
			subagentCount,
		});
		metaItems = [];
	};

	// 轮末行（桌面路径）：位置式插入——turn i 的行插到第 i+1 条 user 行之前，最后一轮追加到行序列末尾。
	// （不锚消息行：轮末 assistant 无正文时会被吸进折叠组，没有独立行可锚。streaming 中的轮次工具未固化
	// 进 messages，天然不满足「turn_end 后才出现」）传了 turnTimings 则每轮必产行（计时恒显，diff 条件渲染）；
	// 只传 turnChanges（lan-web 老路径）则保持原行为：有文件变更才产行。
	const { turnChanges, turnTimings, enteringTurn } = opts ?? {};
	const changeByTurn = turnChanges ? new Map(turnChanges.map((tc) => [tc.turnIndex, tc])) : null;
	const timingByTurn = turnTimings ? new Map(turnTimings.map((tt) => [tt.turnIndex, tt])) : null;
	let userRowCount = 0;
	const pushTurnDiffRow = (turnIndex: number, running: boolean): void => {
		rows.push({
			kind: "turnDiff",
			key: `turn-diff-${turnIndex}`,
			changes: changeByTurn?.get(turnIndex),
			timing: timingByTurn?.get(turnIndex),
			running,
			// 前一行是折叠组（纯工具轮/被打断轮无正文，组自带 -mb-4 对消 gap）→ chip 不再上提
			afterMetaGroup: rows[rows.length - 1]?.kind === "metaGroup",
			entering: turnIndex === enteringTurn,
		});
	};
	const hasFooterRow = (turnIndex: number): boolean =>
		Boolean(changeByTurn?.get(turnIndex) || timingByTurn?.get(turnIndex));

	for (const message of transcript.messages) {
		if (message.kind === "subagent") {
			// 子代理结果发生在调用工具之后：无论该轮是否还有普通工具/思考，都先落一条所属的
			// 折叠状态行，再紧接卡片。不能回补“上一个”组，否则纯子代理轮会跳到前一轮顶部。
			flushMeta(false, false, message.runs.length);
			rows.push({
				kind: "message",
				key: message.id,
				message,
				metaInGroup: false,
				showActions: false,
				streaming: false,
			});
			continue;
		}
		if (message.kind !== "assistant") {
			flushMeta();
			if (message.kind === "user" && (changeByTurn || timingByTurn)) {
				if (hasFooterRow(userRowCount - 1)) pushTurnDiffRow(userRowCount - 1, false);
				userRowCount++;
			}
			rows.push({
				kind: "message",
				key: message.id,
				message,
				metaInGroup: false,
				showActions: false,
				streaming: false,
			});
			continue;
		}
		// 思考/工具（含正文消息自带的）全部进当前组（缓存复用，保证 items 元素引用跨渲染稳定）
		if (message.thinking || message.tools.length > 0) {
			metaItems.push(committedMetaItem(message));
		}
		// 正文是边界：组关闭，正文独立成行（meta 已并入组）
		if (message.text) {
			flushMeta();
			rows.push({
				kind: "message",
				key: message.id,
				message,
				metaInGroup: true,
				showActions: turnFinalTextIds.has(message.id),
				streaming: false,
			});
		}
	}

	if (streaming) {
		// 正文起点锚：同 turn 的工具按 blockIndex 分「正文前/正文后」两组，保住 text→toolCall 交错时序
		//（与 finalizeStreaming 的拆分一致）；正文出现后 pre 组立即结束，post 组成为最新组接收 working 信号
		const textIdx = streaming.textBlockIndex;
		const preTools =
			textIdx == null ? streaming.tools : streaming.tools.filter((t) => (t.blockIndex ?? 0) < textIdx);
		const postTools = textIdx == null ? [] : streaming.tools.filter((t) => (t.blockIndex ?? 0) > textIdx);
		if (streaming.thinking || preTools.length > 0) {
			metaItems.push({
				thinking: streaming.thinking,
				tools: preTools,
				// 正文已出现时 pre 组被强制结束（endImmediately），不再携带活动序列；未出正文时维持现状
				activity: textIdx == null ? streaming.activity : undefined,
			});
		}
		if (streaming.text) {
			flushMeta();
			rows.push({
				kind: "message",
				key: streaming.id,
				message: {
					kind: "assistant",
					id: streaming.id,
					text: streaming.text,
					thinking: streaming.thinking,
					tools: streaming.tools,
					timestamp: now,
				},
				metaInGroup: true,
				showActions: false,
				streaming: true,
			});
		}
		// 正文后的工具进新组（成为最新组）：working 预览行继续显示最新活动
		if (postTools.length > 0) {
			metaItems.push({ thinking: "", tools: postTools, activity: streaming.activity });
		}
	}
	// 最新组无内容但仍在工作（正文已出、工具/子代理执行中）：挂上流式活动序列，预览行继续显示最新活动
	if (metaItems.length === 0 && agentWorking && streaming && streaming.activity.length > 0) {
		metaItems.push({ thinking: "", tools: [], activity: streaming.activity });
	}
	// 流式子代理也属于当前最后一条状态行：先 flush 状态行、后挂卡片行，避免卡片倒挂在折叠行上方。
	const streamingSubagentRuns = streaming?.subagentRuns ?? [];
	flushMeta(true, agentWorking, streamingSubagentRuns.length);
	if (streamingSubagentRuns.length > 0) {
		rows.push({ kind: "streamingSubagents", key: "streaming-subagents", runs: streamingSubagentRuns });
	}
	// 最后一轮（无下一条 user 行）的行追加到行序列末尾；running = agent 仍在该轮工作（timer 跳动）
	if (changeByTurn || timingByTurn) {
		if (hasFooterRow(userRowCount - 1)) pushTurnDiffRow(userRowCount - 1, transcript.agentActive);
	}
	return rows;
}
