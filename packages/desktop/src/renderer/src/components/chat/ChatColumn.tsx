import type { CSSProperties, ReactNode } from "react";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

/** Keep width previews out of App's subscriptions so dragging does not re-render the transcript. */
export function ChatColumn({ sessionId, children }: { sessionId: string | null; children: ReactNode }) {
	const width = useUiPreferencesStore((s) => s.chatColumnWidth);
	return (
		<div
			className="relative flex min-w-0 flex-1 flex-col"
			data-session-page=""
			data-session-id={sessionId ?? ""}
			style={{ "--chat-column-width": `${width}px` } as CSSProperties}
		>
			{children}
		</div>
	);
}
