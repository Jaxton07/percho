import { buildChatRows, deriveTurnChanges, isAgentWorking, type TurnChanges } from "@percho/shared";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { Slot } from "../../plugins/Slot";
import { UI_SLOTS } from "../../plugins/slots";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { CenterOrb } from "./CenterOrb";
import { MessageItem } from "./MessageItem";
import { MetaGroup } from "./MetaGroup";
import { RetryNote } from "./RetryNote";
import { SubagentRunCard } from "./SubagentRunCard";
import { TurnDiffChip } from "./TurnDiffChip";
import { useShownWorking } from "./use-shown-working";

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
	/** agent 运行中且正文未出现 → 折叠组标题 working；正文已出但工具/子代理还在跑时不熄灯 */
	const agentWorking = isAgentWorking(transcript);

	// 中央状态动画（设置开关，与状态行小 orb 解耦）：与 MetaGroup 同一 working 信号 + 同一滞后缓冲，
	// 显隐节奏一致；动画两态合一为中速单动画（无状态切换），CenterOrb 只收 visible。
	// 滞后缓冲只在 run 存活期内生效：正文在输出或 run 已终结（!agentActive）时立即结束——
	// 杜绝结束/中止后的 1.5s 滞留；resetKey=会话 id：切会话立即对齐新信号，不滞留旧动画
	const centerOrbEnabled = useUiPreferencesStore((s) => s.centerOrbEnabled);
	const shownWorking = useShownWorking(
		agentWorking,
		Boolean(streaming?.text) || !transcript.agentActive,
		activeSessionId,
	);

	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	/** 跟随状态的 ref 镜像：ResizeObserver / scroll 回调里读最新值 */
	const followingRef = useRef(true);
	const [following, setFollowing] = useState(true);
	const lastScrollTopRef = useRef(0);
	const lastScrollHeightRef = useRef(0);

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

	// 仅「向上滚动」脱离跟随（程序性向下贴底/平滑回底不中断跟随）；到达底部恢复。
	// 压缩/消息重建会让内容变矮、浏览器把 scrollTop 往下钳——高度收缩导致的 top 下降
	// 不是用户意图，不释放跟随（否则每次 compaction 后跟随静默死亡）；RO 会随即重新贴底。
	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const heightShrank = el.scrollHeight < lastScrollHeightRef.current;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
		if (atBottom) updateFollowing(true);
		else if (el.scrollTop < lastScrollTopRef.current && !heightShrank) updateFollowing(false);
		lastScrollTopRef.current = el.scrollTop;
		lastScrollHeightRef.current = el.scrollHeight;
	};

	// 展开/折叠任何折叠组（details summary）→ 释放底部跟随：否则贴底 RO 会在高度动画期间
	// 持续拉回底部，出现「Worked 上移 + 内容下展」两边同动的不稳定感。释放后视口钉在点击处、
	// 新内容向下展开，与「向上滚动脱离」同一语义（滚回底部即恢复跟随）
	const handleSummaryToggle = (e: MouseEvent) => {
		if (e.target instanceof Element && e.target.closest("summary")) updateFollowing(false);
	};

	// 轮次文件变更 chip：位置式插入——turn i 的 chip 插到第 i+1 条 user 行之前，最后一轮追加到末尾。
	//（不锚消息行：轮末 assistant 无正文时会被吸进折叠组，没有独立行可锚。streaming 中的轮次
	// 工具未固化进 messages，天然不满足「turn_end 后才出现」）
	const turnChanges = useMemo(() => deriveTurnChanges(transcript.messages), [transcript.messages]);
	// 进场动画只给「本会话查看期间新完成的最后一轮」播：基线在切会话/历史重建时对齐，不随渲染更新（防 agent_end 紧随的二次渲染摘掉动画类）
	const turnBaselineRef = useRef({ sid: activeSessionId, count: 0 });
	if (turnBaselineRef.current.sid !== activeSessionId) {
		turnBaselineRef.current = { sid: activeSessionId, count: turnChanges.length };
	}
	const enteringTurn =
		turnChanges.length > turnBaselineRef.current.count
			? turnChanges[turnChanges.length - 1]?.turnIndex
			: null;

	// 行序列由 shared buildChatRows 产出（与 lan-web 同一分组大脑）；此处只做行模型 → JSX 映射。
	// useMemo：滚动/跟随等本组件局部 state 翻转不重跑（历史长会话单次 ~60µs+）；transcript 每
	// 次变更（合流后 ≤ 1 次/帧）重跑一次是预期成本
	const rows = useMemo(
		() => buildChatRows(transcript, String(activeSessionId)),
		[transcript, activeSessionId],
	);
	const chipBeforeRow = new Map<number, TurnChanges>();
	const changeByTurn = new Map(turnChanges.map((tc) => [tc.turnIndex, tc]));
	let userRowCount = 0;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row?.kind === "message" && row.message.kind === "user") {
			const tc = changeByTurn.get(userRowCount - 1);
			if (tc) chipBeforeRow.set(i, tc);
			userRowCount++;
		}
	}
	// 最后一轮（无下一条 user 行）的 chip 追加到行序列末尾
	const tailChanges = changeByTurn.get(userRowCount - 1);

	// 已完成轮次保留上提 16px，和普通消息的 8px 净距对齐；当前运行轮不应上提：
	// MetaGroup 的圆点仍会实时追加，否则 diff 会贴到圆点行上。
	const renderChip = (tc: TurnChanges, running = false) => (
		<div key={`turn-diff-${tc.turnIndex}`} className={running ? undefined : "-mt-4"}>
			<TurnDiffChip changes={tc} entering={tc.turnIndex === enteringTurn} />
		</div>
	);

	const items: React.ReactNode[] = [];
	rows.forEach((row, rowIndex) => {
		const chip = chipBeforeRow.get(rowIndex);
		if (chip) items.push(renderChip(chip));
		if (row.kind === "metaGroup") {
			items.push(
				<MetaGroup
					key={row.key}
					items={row.items}
					working={row.working}
					endImmediately={row.endImmediately}
					subagentCount={row.subagentCount}
				/>,
			);
			return;
		}
		if (row.kind === "streamingSubagents") {
			items.push(
				<Slot
					key={row.key}
					name={UI_SLOTS.SubagentCard}
					props={{ runs: row.runs }}
					fallback={SubagentRunCard}
				/>,
			);
			return;
		}
		items.push(
			<MessageItem
				key={row.key}
				message={row.message}
				metaInGroup={row.metaInGroup}
				showActions={row.showActions}
				streaming={row.streaming}
				sessionId={activeSessionId}
			/>,
		);
	});
	if (tailChanges) items.push(renderChip(tailChanges, transcript.agentActive));

	return (
		<div className="relative h-full">
			{/* 中央状态动画：z-20 在文字层（z-10 滚动容器）之上——canvas 一体遮罩压住身后文字、
			    凸显动画本体（用户规格：工作中不看文字）；pointer-events-none 不拦截交互 */}
			{centerOrbEnabled && <CenterOrb visible={shownWorking} />}
			{/* overflow-x-hidden：任何行内容异常超宽都只裁剪，不产生页面级横向滚动条 */}
			{/* scrollbar-gutter:stable：永久保留滚动条槽位——展开折叠组跨过溢出阈值时滚动条出现/消失
			    会挤掉布局宽度，导致居中列（mx-auto max-w-760）整体左右横移；悬浮滚动条模式下无副作用 */}
			{/* relative z-10：无背景；CenterOrb（z-20）连同其 canvas 遮罩盖在本层之上（工作中场景），
			    交互不受影响（orb 整层 pointer-events-none） */}
			<div
				ref={scrollRef}
				onScroll={handleScroll}
				onClickCapture={handleSummaryToggle}
				className="chat-scrollbar relative z-10 h-full overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
			>
				<div ref={contentRef} className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 pt-8 pb-16">
					{items}
					{transcript.retrying && <RetryNote info={transcript.retrying} />}
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
