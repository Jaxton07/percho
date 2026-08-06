import type { AgentSessionEvent } from "@pi-desktop/shared";
import { useEffect } from "react";
import { getPi } from "./api";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { MessageList } from "./components/MessageList";
import { PermissionDialog } from "./components/PermissionDialog";
import { SessionTabBar } from "./components/SessionTabBar";
import { SettingsDialog } from "./components/SettingsDialog";
import { StatusBar } from "./components/StatusBar";
import { useSessionsStore } from "./stores/sessions";
import { useTranscriptStore } from "./stores/transcript";

export default function App() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const transcript = useTranscriptStore((s) => (activeSessionId ? s.bySession[activeSessionId] : undefined));

	useEffect(() => {
		const pi = getPi();
		const offEvent = pi.onEvent(({ sessionId, event }: { sessionId: string; event: AgentSessionEvent }) => {
			useTranscriptStore.getState().applyEvent(sessionId, event);
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
			<main className="relative min-h-0 flex-1">
				{showEmpty ? <EmptyState /> : <MessageList />}
				<PermissionDialog sessionId={activeSessionId} />
			</main>
			<Composer />
			<StatusBar />
			<SettingsDialog />
		</div>
	);
}
