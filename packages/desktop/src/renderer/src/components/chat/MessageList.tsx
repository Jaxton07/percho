import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";
import { MessageItem } from "./MessageItem";
import { MetaGroup, type MetaItem } from "./MetaGroup";

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
	/** agent 运行中且正文未出现（用户消息 → 下一次正文回复之间）→ 折叠组标题 working */
	const agentWorking = transcript.agentActive && !transcript.streaming?.text;

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

	const items: ReactNode[] = [];
	let metaItems: MetaItem[] = [];
	/** 组序号：key 按位置稳定（streaming→committed 转换不 remount，正文边界后的新组自增） */
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
				key={`meta-g${groupIndex++}`}
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
			items.push(<MessageItem key={message.id} message={message} metaInGroup />);
		}
	}
	if (transcript.streaming) {
		const streaming = transcript.streaming;
		if (streaming.thinking || streaming.tools.length > 0) {
			metaItems.push({
				thinking: streaming.thinking,
				tools: streaming.tools,
				activity: streaming.activity,
			});
		}
		if (streaming.text) {
			flushMeta();
			items.push(
				<MessageItem
					key="streaming"
					message={{
						kind: "assistant",
						id: "streaming",
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
	}
	flushMeta(true, agentWorking);

	return (
		<div className="relative h-full">
			<div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
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
					className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-200 bg-white/95 px-3 py-1.5 text-xs text-zinc-600 shadow-md backdrop-blur transition-colors hover:bg-zinc-50"
					title={t("message.scrollToBottom")}
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
