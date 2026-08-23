import { buildChatRows } from "@percho/shared";
import { useEffect, useRef } from "react";
import { t } from "../i18n";
import { useLanStore } from "../store";
import { MessageItem } from "./MessageItem";
import { MetaGroup } from "./MetaGroup";
import { PermissionCard } from "./PermissionCard";
import { SubagentCard } from "./SubagentCard";
import { TodoStrip } from "./TodoStrip";

/** 聊天视图：行序列由 shared buildChatRows 产出（与桌面 MessageList 同一分组大脑）；
 *  流式期间吸底（上滑解除）。无 transcript（历史会话）时按需拉取。 */
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
	const loadTranscript = useLanStore((s) => s.loadTranscript);
	const seeded = useLanStore((s) => s.seeded);
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

	// 历史会话：无 transcript 种子时按需拉取（GET /api/sessions/:id/transcript）
	useEffect(() => {
		if (seeded && !transcript) void loadTranscript(sessionId);
	}, [seeded, transcript, sessionId, loadTranscript]);

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	};

	if (!transcript) {
		return <div className="empty">{t("chat.loading")}</div>;
	}

	const rows = buildChatRows(transcript, sessionId);

	return (
		<div className="chat" ref={scrollRef} onScroll={onScroll}>
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
	);
}
