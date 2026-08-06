import type { AgentSessionEvent } from "@pi-desktop/shared";
import { useEffect } from "react";
import { getPi } from "./api";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { MessageList } from "./components/MessageList";
import { PermissionDialog } from "./components/PermissionDialog";
import { ProjectPage } from "./components/ProjectPage";
import { SessionTabBar } from "./components/SessionTabBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { useSessionsStore } from "./stores/sessions";
import { useTranscriptStore } from "./stores/transcript";
import { useUiStore } from "./stores/ui";

export default function App() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const view = useUiStore((s) => s.view);
	const transcript = useTranscriptStore((s) => (activeSessionId ? s.bySession[activeSessionId] : undefined));

	useEffect(() => {
		const pi = getPi();
		const offEvent = pi.onEvent(({ sessionId, event }: { sessionId: string; event: AgentSessionEvent }) => {
			useTranscriptStore.getState().applyEvent(sessionId, event);
			if (event.type === "session_info_changed") {
				useSessionsStore.getState().updateSessionName(sessionId, event.name);
			}
		});
		const offPermission = pi.onPermissionRequest((req) => {
			useTranscriptStore.getState().addPermission(req.sessionId, req);
		});
		void useSessionsStore.getState().loadModels();
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
				<div className="min-h-0 flex-1 p-3">
					<ProjectPage />
				</div>
			) : (
				<>
					<main className="relative min-h-0 flex-1">
						{showEmpty ? <EmptyState /> : <MessageList />}
						<PermissionDialog sessionId={activeSessionId} />
					</main>
					{!showEmpty && (
						<>
							<Composer />
							<StatusBar />
						</>
					)}
				</>
			)}
			<SettingsDialog />
		</div>
	);
}
