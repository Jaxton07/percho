import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { MessageItem } from "./MessageItem";
import { MetaGroup, type MetaItem } from "./MetaGroup";
import { SubagentRunCard } from "./SubagentRunCard";

/** 距底 ≤ 此值视为「在底部」，自动恢复跟随 */
const BOTTOM_THRESHOLD = 48;

/**
 * 中央消息流：最大宽度 760px 居中。
 * 合并规则：assistant 消息的思考/工具全部并入一个折叠组，正文（text）是边界——
 * 正文出现时组关闭、正文作为独立块渲染（与 working 定义一致：用户消息 → 下一次正文之间）。
 *
 * 底部跟随：ResizeObserver 监听内容/容器尺寸（流式追加、图片加载、窗口缩放），
 * 跟随中即时贴底（RO 回调早于 paint，无闪烁）；仅「向上滚动」脱离跟随，回到底部恢复；
 * 用户发出新消息与切换会话时强制回底。脱离跟随时显示浮动回底按钮。
 */
export function MessageList() {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const transcript = useTranscriptStore((s) => selectTranscript(s, activeSessionId));
	const streaming = transcript.streaming;
	/** 执行中的工具/子代理：工具执行发生在 message_end 之后、turn_end 之前，期间 streaming.text 仍在 */
	const hasRunningWork = Boolean(
		streaming?.tools.some((t) => t.state === "running") ||
			streaming?.subagentRuns.some((r) => r.status === "running"),
	);
	/** agent 运行中且正文未出现 → 折叠组标题 working；正文已出但工具/子代理还在跑时不熄灯 */
	const agentWorking = transcript.agentActive && (!streaming?.text || hasRunningWork);

	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	/** 跟随状态的 ref 镜像：ResizeObserver / scroll 回调里读最新值 */
	const followingRef = useRef(true);
	const [following, setFollowing] = useState(true);
	const lastScrollTopRef = useRef(0);

	const updateFollowing = useCallback((value: boolean) => {
		followingRef.current = value;
		setFollowing(value);
	}, []);

	const pinToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
		const el = scrollRef.current;
		if (el) el.scrollTo({ top: el.scrollHeight, behavior });
	}, []);

	// 尺寸变化（流式追加、图片加载、窗口缩放）→ 跟随中保持贴底
	useEffect(() => {
		const scroll = scrollRef.current;
		const content = contentRef.current;
		if (!scroll || !content) return;
		const observer = new ResizeObserver(() => {
			if (followingRef.current) pinToBottom();
		});
		observer.observe(content);
		observer.observe(scroll);
		return () => observer.disconnect();
	}, [pinToBottom]);

	// 用户发出新消息（末条变为 user）→ 立即回底并恢复跟随
	const lastMessage = transcript.messages[transcript.messages.length - 1];
	const lastUserMessageId = lastMessage?.kind === "user" ? lastMessage.id : null;
	useEffect(() => {
		if (!lastUserMessageId) return;
		updateFollowing(true);
		pinToBottom();
	}, [lastUserMessageId, pinToBottom, updateFollowing]);

	// 切换会话 → 回到底部并恢复跟随
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeSessionId 是刻意的重跑触发器（切换会话时重新贴底）
	useEffect(() => {
		updateFollowing(true);
		pinToBottom();
	}, [activeSessionId, pinToBottom, updateFollowing]);

	// 仅「向上滚动」脱离跟随（程序性向下贴底/平滑回底不中断跟随）；到达底部恢复
	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
		if (atBottom) updateFollowing(true);
		else if (el.scrollTop < lastScrollTopRef.current) updateFollowing(false);
		lastScrollTopRef.current = el.scrollTop;
	};

	// 展开/折叠任何折叠组（details summary）→ 释放底部跟随：否则贴底 RO 会在高度动画期间
	// 持续拉回底部，出现「Worked 上移 + 内容下展」两边同动的不稳定感。释放后视口钉在点击处、
	// 新内容向下展开，与「向上滚动脱离」同一语义（滚回底部即恢复跟随）
	const handleSummaryToggle = (e: MouseEvent) => {
		if (e.target instanceof Element && e.target.closest("summary")) updateFollowing(false);
	};

	const items: ReactNode[] = [];
	let metaItems: MetaItem[] = [];
	/**
	 * 轮次末段正文 id 集合：以 user 消息为轮次边界，每轮（agent 一次回复）只给最后一段正文
	 * 挂复制/fork 操作行——中间多段是工具循环里的自言自语，全部挂按钮噪音太大。
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
	/** 组序号：同会话内 key 按位置稳定（streaming→committed 转换不 remount，正文边界后的新组自增）；
	 *  key 含会话 id：切会话强制 remount——shownWorking 滞后/预览行调度等组内本地状态不跨会话泄漏 */
	let groupIndex = 0;
	/**
	 * isLatest：是否为当前 run 的组（仅最后一个组接收 working 信号，历史组恒为已完成）
	 * forceEmpty：agent 工作中即使无内容也渲染（占位与流式组一体：空组 = 工作中 + 思考中预览）
	 */
	const flushMeta = (isLatest = false, forceEmpty = false) => {
		if (metaItems.length === 0 && !forceEmpty) return;
		// 正文在输出 → 工作组强制结束（streaming 里残留的 thinking/tools 不延长工作中）
		const endByText = Boolean(transcript.streaming?.text);
		items.push(
			<MetaGroup
				key={`meta-${activeSessionId}-g${groupIndex++}`}
				items={metaItems}
				working={isLatest && agentWorking}
				endByText={endByText}
			/>,
		);
		metaItems = [];
	};

	for (const message of transcript.messages) {
		if (message.kind !== "assistant") {
			flushMeta();
			items.push(<MessageItem key={message.id} message={message} />);
			continue;
		}
		// 思考/工具（含正文消息自带的）全部进当前组
		if (message.thinking || message.tools.length > 0) {
			metaItems.push({ thinking: message.thinking, tools: message.tools });
		}
		// 正文是边界：组关闭，正文独立渲染（meta 已并入组）
		if (message.text) {
			flushMeta();
			items.push(
				<MessageItem
					key={message.id}
					message={message}
					metaInGroup
					showActions={turnFinalTextIds.has(message.id)}
				/>,
			);
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
				// 正文已出现时 pre 组被强制结束（endByText），不再携带活动序列；未出正文时维持现状
				activity: textIdx == null ? streaming.activity : undefined,
			});
		}
		if (streaming.text) {
			flushMeta();
			items.push(
				<MessageItem
					// key = 预生成的消息 id：turn_end 固化后同 id 进入 messages，流式 → 固化不 remount
					// （Markdown 平滑输出 controller 存活，固化后继续追平剩余 backlog 不跳变）
					key={streaming.id}
					message={{
						kind: "assistant",
						id: streaming.id,
						text: streaming.text,
						thinking: streaming.thinking,
						tools: streaming.tools,
						timestamp: Date.now(),
					}}
					streaming
					metaInGroup
				/>,
			);
		}
		// 正文后的工具进新组（成为最新组）：working 预览行继续显示最新活动，尾部 flushMeta 接管 working 信号
		if (postTools.length > 0) {
			metaItems.push({ thinking: "", tools: postTools, activity: streaming.activity });
		}
		// 子代理运行中行：tool_execution_start 即入缓冲，流式期就展示（不等 turn_end 固化），顺序对齐固化后的 assistant → subagents
		if (streaming.subagentRuns.length > 0) {
			items.push(<SubagentRunCard key="streaming-subagents" runs={streaming.subagentRuns} />);
		}
	}
	// 最新组无内容但仍在工作（正文已出、工具/子代理执行中）：挂上流式活动序列，预览行继续显示最新活动
	if (metaItems.length === 0 && agentWorking && streaming && streaming.activity.length > 0) {
		metaItems.push({ thinking: "", tools: [], activity: streaming.activity });
	}
	flushMeta(true, agentWorking);

	return (
		<div className="relative h-full">
			{/* overflow-x-hidden：任何行内容异常超宽都只裁剪，不产生页面级横向滚动条 */}
			{/* scrollbar-gutter:stable：永久保留滚动条槽位——展开折叠组跨过溢出阈值时滚动条出现/消失
			    会挤掉布局宽度，导致居中列（mx-auto max-w-760）整体左右横移；悬浮滚动条模式下无副作用 */}
			<div
				ref={scrollRef}
				onScroll={handleScroll}
				onClickCapture={handleSummaryToggle}
				className="h-full overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
			>
				<div ref={contentRef} className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 pt-8 pb-16">
					{items}
				</div>
			</div>
			{!following && (
				<button
					type="button"
					onClick={() => {
						updateFollowing(true);
						pinToBottom(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
					}}
					className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface/95 px-3 py-1.5 text-xs text-ink-2 shadow-pop backdrop-blur transition-colors hover:bg-hover"
					aria-label={t("message.scrollToBottom")}
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M12 5v14" />
						<path d="m19 12-7 7-7-7" />
					</svg>
					{t("message.scrollToBottom")}
				</button>
			)}
		</div>
	);
}
