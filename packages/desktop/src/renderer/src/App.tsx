import type { AgentSessionEvent } from "@pi-desktop/shared";
import { useEffect } from "react";
import { getPi } from "./api";
import { EmptyState } from "./components/chat/EmptyState";
import { MessageList } from "./components/chat/MessageList";
import { Composer } from "./components/composer/Composer";
import { ProjectPage } from "./components/projects/ProjectPage";
import { PermissionDialog } from "./components/session/PermissionDialog";
import { SessionTabBar } from "./components/session/SessionTabBar";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { useSessionsStore } from "./stores/sessions";
import { useTranscriptStore } from "./stores/transcript";
import { messagesToUIMessages } from "./stores/transcript-reducer";
import { useUiStore } from "./stores/ui";

export default function App() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const view = useUiStore((s) => s.view);
	const transcript = useTranscriptStore((s) => (activeSessionId ? s.bySession[activeSessionId] : undefined));

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
				useTranscriptStore.getState().applyEvent(sessionId, event);
				if (event.type === "session_info_changed") {
					useSessionsStore.getState().updateSessionName(sessionId, event.name);
				}
			},
		);
		const offPermission = pi.onPermissionRequest((req) => {
			useTranscriptStore.getState().addPermission(req.sessionId, req);
		});
		void useSessionsStore.getState().loadModels();
		void useSessionsStore.getState().restoreTabs();
		return () => {
			offEvent();
			offPermission();
		};
	}, []);

	const showEmpty = !transcript || (transcript.messages.length === 0 && !transcript.streaming);

	return (
		<div className="flex h-full flex-col">
			<SessionTabBar />
			{view === "projects" ? (
				<div className="min-h-0 flex-1">
					<ProjectPage />
				</div>
			) : (
				<>
					<main className="relative min-h-0 flex-1">
						{showEmpty ? <EmptyState /> : <MessageList />}
						<PermissionDialog sessionId={activeSessionId} />
					</main>
					{!showEmpty && <Composer />}
				</>
			)}
			<SettingsDialog />
		</div>
	);
}
