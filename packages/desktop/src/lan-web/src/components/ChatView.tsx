import { buildChatRows } from "@percho/shared";
import { useCallback, useEffect, useRef } from "react";
import { t } from "../i18n";
import { useLanStore } from "../store";
import { ShieldIcon } from "./icons";
import { Markdown } from "./Markdown";
import { MessageItem } from "./MessageItem";
import { MetaGroup } from "./MetaGroup";
import { PermissionCard } from "./PermissionCard";
import { SubagentCard } from "./SubagentCard";
import { TodoStrip } from "./TodoStrip";

/** tokens 千分缩写（12.4k 风格，对齐设计稿用量行） */
function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
}

/** 距底 ≤ 此值视为「在底部」，自动恢复跟随 */
const BOTTOM_THRESHOLD = 60;

/** 聊天视图：行序列由 shared buildChatRows 产出（与桌面 MessageList 同一分组大脑）；
 *  流式期间吸底（上滑解除）。无 transcript（历史会话）时按需拉取。
 *  底部跟随：ResizeObserver 监听内容/容器尺寸（流式追加、markstream 平滑揭示、键盘弹起），
 *  跟随中即时贴底；仅「向上滑动」脱离跟随，回到底部恢复；内容变矮（压缩重建）不误判。 */
export function ChatView({
	sessionId,
	isDark,
	onRespond,
}: {
	sessionId: string;
	isDark: boolean;
	onRespond?: (requestId: string, answer: "allowOnce" | "deny") => Promise<boolean>;
}) {
	const transcript = useLanStore((s) => s.transcripts[sessionId]);
	const view = useLanStore((s) => s.views[sessionId]);
	const truncated = useLanStore((s) => s.truncated[sessionId]);
	const perms = useLanStore((s) => s.pendingPerms[sessionId]);
	// 中途进入自愈标记（错过 message_start 的 run：流式帧空转，用 view.assistantTail 兑底渲染）
	const healing = useLanStore((s) => s.streamHealing[sessionId] === true);
	const remoteControl = useLanStore((s) => s.remoteControl);
	const loadTranscript = useLanStore((s) => s.loadTranscript);
	const seeded = useLanStore((s) => s.seeded);
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	/** 跟随状态的 ref 镜像：ResizeObserver / scroll 回调里读最新值 */
	const followingRef = useRef(true);
	const lastScrollTopRef = useRef(0);
	const lastScrollHeightRef = useRef(0);

	const pinToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	// 尺寸变化（流式追加、平滑揭示逐字增高、窗口/键盘缩放）→ 跟随中保持贴底；
	// RO 回调早于 paint，无闪烁。覆盖旧版按依赖信号贴底追不上平滑揭示的洞。
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

	// 历史会话：无 transcript 种子时按需拉取（GET /api/sessions/:id/transcript）
	useEffect(() => {
		if (seeded && !transcript) void loadTranscript(sessionId);
	}, [seeded, transcript, sessionId, loadTranscript]);

	// 仅「向上滑动」脱离跟随（程序性贴底不中断）；到达底部恢复。
	// 内容变矮（压缩后重建）浏览器会下钳 scrollTop——非用户意图，不释放跟随。
	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		const heightShrank = el.scrollHeight < lastScrollHeightRef.current;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
		if (atBottom) followingRef.current = true;
		else if (el.scrollTop < lastScrollTopRef.current && !heightShrank) followingRef.current = false;
		lastScrollTopRef.current = el.scrollTop;
		lastScrollHeightRef.current = el.scrollHeight;
	};

	if (!transcript) {
		return <div className="empty">{t("chat.loading")}</div>;
	}

	const rows = buildChatRows(transcript, sessionId);
	const permCount = perms?.length ?? 0;

	return (
		<div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
			<div ref={contentRef} className="chat-content">
				{truncated && <div className="truncated-note">{t("chat.truncated")}</div>}
				{transcript.todos.length > 0 && <TodoStrip todos={transcript.todos} />}
				{rows.map((row) => {
					if (row.kind === "metaGroup") {
						return (
							<MetaGroup
								key={row.key}
								items={row.items}
								working={row.working}
								endImmediately={row.endImmediately}
								subagentCount={row.subagentCount}
								isDark={isDark}
							/>
						);
					}
					if (row.kind === "streamingSubagents") {
						return (
							<div key={row.key} className="msg-assistant">
								<SubagentCard runs={row.runs} />
							</div>
						);
					}
					return (
						<MessageItem
							key={row.key}
							message={row.message}
							isDark={isDark}
							enter={false}
							streaming={row.streaming}
							metaInGroup={row.metaInGroup}
						/>
					);
				})}
				{/* 中途进入兑底：run 在进行但本地无流式容器时，用 view 投影的 assistantTail
				    渲染实时正文（view 帧 120ms 合帧推送）；run 边界摘标记 + 快照取回已提交消息 */}
				{healing && view?.assistantTail && (
					<div className="m-assistant">
						<Markdown text={view.assistantTail} isDark={isDark} streaming />
					</div>
				)}
				{(perms ?? []).map((request) => (
					<PermissionCard
						key={request.id}
						request={request}
						remoteControl={remoteControl}
						onRespond={onRespond}
					/>
				))}
				{/* M1 只读兜底：perm 帧未覆盖时（旧服务）用 view 投影显示等待横幅 */}
				{permCount === 0 && view?.pendingPermission && (
					<div className="perm-card2">
						<div className="perm-head">
							<span className="perm-ic">
								<ShieldIcon size={16} />
							</span>
							<div>
								<div className="perm-title">{view.pendingPermission.title}</div>
								<div className="perm-sub">{t("perm.subtitle")}</div>
							</div>
							<span className="pulse-dot amber" style={{ marginLeft: "auto" }} />
						</div>
						<div className="perm-cmd">{view.pendingPermission.message}</div>
						<div className="perm-waiting">{t("perm.waiting")}</div>
					</div>
				)}
				{/* 用量行（StatusBar 拆解后 tokens 落点）：有 stats 时显示 */}
				{view?.stats && (
					<div className="usage-line">
						{t("chat.usage", {
							in: formatTokens(view.stats.inputTokens),
							out: formatTokens(view.stats.outputTokens),
						})}
					</div>
				)}
			</div>
		</div>
	);
}
