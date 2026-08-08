import type { AgentSessionEvent, TrustRequest } from "@pi-desktop/shared";
import { useEffect, useState } from "react";
import { getPi } from "./api";
import { EmptyState } from "./components/chat/EmptyState";
import { MessageList } from "./components/chat/MessageList";
import { ProjectPage } from "./components/projects/ProjectPage";
import { ApprovalDock } from "./components/session/ApprovalDock";
import { SessionTabBar } from "./components/session/SessionTabBar";
import { TrustDialog } from "./components/session/TrustDialog";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { useSessionsStore } from "./stores/sessions";
import { backgroundImageUrl, useThemeStore } from "./stores/theme";
import { useTranscriptStore } from "./stores/transcript";
import { messagesToUIMessages } from "./stores/transcript-reducer";
import { useUiStore } from "./stores/ui";

export default function App() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const view = useUiStore((s) => s.view);
	const transcript = useTranscriptStore((s) => (activeSessionId ? s.bySession[activeSessionId] : undefined));
	const [trustRequests, setTrustRequests] = useState<TrustRequest[]>([]);

	useEffect(() => {
		const pi = getPi();
		const offEvent = pi.onEvent(
			async ({ sessionId, event }: { sessionId: string; event: AgentSessionEvent }) => {
				// 压缩成功后 pi 内部消息被裁剪，重新拉取对齐 UI 消息流
				if (event.type === "compaction_end" && !event.aborted && event.result) {
					try {
						const history = await pi.getSessionMessages(sessionId);
						useTranscriptStore.getState().loadHistory(sessionId, messagesToUIMessages(history));
					} catch {
						// 拉取失败不阻塞事件应用
					}
				}
				useTranscriptStore.getState().applyEvent(sessionId, event, {
					// 正被查看（活跃 tab 且 chat 视图）的会话完成时不打未读标记
					isActiveViewing:
						useSessionsStore.getState().activeSessionId === sessionId &&
						useUiStore.getState().view === "chat",
				});
				if (event.type === "session_info_changed") {
					useSessionsStore.getState().updateSessionName(sessionId, event.name);
				}
			},
		);
		const offPermission = pi.onPermissionRequest((req) => {
			useTranscriptStore.getState().addPermission(req.sessionId, req);
		});
		const offTrust = pi.onTrustRequest((req) => {
			setTrustRequests((prev) => [...prev, req]);
		});
		void useSessionsStore.getState().loadModels();
		void useSessionsStore.getState().restoreTabs();
		return () => {
			offEvent();
			offPermission();
			offTrust();
		};
	}, []);

	const respondTrust = (requestId: string, optionIndex: number) => {
		void getPi().respondTrust(requestId, optionIndex);
		setTrustRequests((prev) => prev.filter((req) => req.id !== requestId));
	};

	const showEmpty = !transcript || (transcript.messages.length === 0 && !transcript.streaming);
	const bgImage = useThemeStore((s) => s.background.image);
	const bgDim = useThemeStore((s) => s.background.dim);

	return (
		<div className="relative h-full">
			{bgImage && (
				<>
					<div className="app-bg" style={{ backgroundImage: `url("${backgroundImageUrl(bgImage)}")` }} />
					<div className="app-bg-scrim" style={{ opacity: bgDim }} />
				</>
			)}
			<div className="relative z-10 flex h-full flex-col">
				<SessionTabBar />
				{view === "projects" ? (
					<div className="min-h-0 flex-1">
						<ProjectPage />
					</div>
				) : (
					<>
						<main className="relative min-h-0 flex-1">{showEmpty ? <EmptyState /> : <MessageList />}</main>
						<ApprovalDock sessionId={activeSessionId} hideComposer={showEmpty} />
					</>
				)}
			</div>
			<SettingsDialog />
			<TrustDialog requests={trustRequests} onRespond={respondTrust} />
		</div>
	);
}
