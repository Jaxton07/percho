import { useEffect, useRef } from "react";
import { t } from "../i18n";
import { useLanStore } from "../store";
import { MessageItem, StreamingMessage } from "./MessageItem";
import { PermissionCard } from "./PermissionCard";
import { TodoStrip } from "./TodoStrip";

/** 聊天视图：消息流 + 流式容器 + 权限横幅 + todo 折叠条；流式期间吸底（上滑解除）。 */
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
	const remoteControl = useLanStore((s) => s.remoteControl);
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);

	const messageCount = transcript?.messages.length ?? 0;
	const streamTextLen = transcript?.streaming?.text.length ?? 0;
	const streamToolCount = transcript?.streaming?.tools.length ?? 0;
	const permCount = perms?.length ?? 0;

	// biome-ignore lint/correctness/useExhaustiveDependencies: 依赖是刻意的滚动触发信号（effect 只读 ref）
	useEffect(() => {
		if (!stickRef.current) return;
		const el = scrollRef.current;
		if (!el) return;
		requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
		});
	}, [messageCount, streamTextLen, streamToolCount, permCount]);

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	};

	if (!transcript) {
		return <div className="empty">{t("list.empty")}</div>;
	}

	return (
		<>
			<div className="chat" ref={scrollRef} onScroll={onScroll}>
				{truncated && <div className="truncated-note">{t("chat.truncated")}</div>}
				{transcript.todos.length > 0 && <TodoStrip todos={transcript.todos} />}
				{transcript.messages.map((message) => (
					<MessageItem key={message.id} message={message} isDark={isDark} enter={false} />
				))}
				{transcript.streaming && <StreamingMessage streaming={transcript.streaming} isDark={isDark} />}
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
					<div className="perm-card">
						<div className="perm-title">
							{t("perm.title")} · {view.pendingPermission.title}
						</div>
						<div className="perm-message">{view.pendingPermission.message}</div>
						<div className="perm-waiting">{t("perm.waiting")}</div>
					</div>
				)}
			</div>
		</>
	);
}
