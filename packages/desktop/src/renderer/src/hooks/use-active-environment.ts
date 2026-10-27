import { environmentEntityRef, LOCAL_ENVIRONMENT } from "@percho/shared";
import { useMemo } from "react";
import { useSessionsStore } from "../stores/sessions";

export function useActiveEnvironment() {
	const session = useSessionsStore((state) => state.activeSessionId);
	const draftEnvironment = useSessionsStore((state) => state.newSessionDraft?.environment);
	return useMemo(
		() => (session ? environmentEntityRef(session).environment : (draftEnvironment ?? LOCAL_ENVIRONMENT)),
		[session, draftEnvironment],
	);
}
