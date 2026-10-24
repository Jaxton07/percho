import {
	type EnvironmentRef,
	environmentEntityRef,
	environmentKey,
	type PendingInteractions,
	type TrustRequest,
} from "@percho/shared";
import { create } from "zustand";
import { getExecutionApi } from "../environment-api";
import { createEventBoundary } from "./session-event-boundary";
import { useTranscriptStore } from "./transcript";

interface InteractionState {
	trustRequests: TrustRequest[];
	selectedTrustId: string | null;
	foregroundTrustCwd: string | null;
	setTrustTarget(cwd: string | null): void;
	ready: Record<string, boolean>;
	selectTrust(id: string): void;
	addTrust(request: TrustRequest): void;
	removeTrust(id: string): void;
}
export const useInteractionStore = create<InteractionState>((set) => ({
	trustRequests: [],
	selectedTrustId: null,
	foregroundTrustCwd: null,
	setTrustTarget: (foregroundTrustCwd) => set({ foregroundTrustCwd }),
	ready: {},
	selectTrust: (selectedTrustId) => set({ selectedTrustId }),
	addTrust: (request) =>
		set((state) => ({
			trustRequests: [...state.trustRequests.filter((item) => item.id !== request.id), request],
		})),
	removeTrust: (id) =>
		set((state) => ({
			trustRequests: state.trustRequests.filter((item) => item.id !== id),
			selectedTrustId: state.selectedTrustId === id ? null : state.selectedTrustId,
		})),
}));
const boundary = createEventBoundary();
export function canAnswerInteraction(id: string | null | undefined): boolean {
	if (!id) return false;
	const env = environmentEntityRef(id).environment;
	return env.kind === "local" || useInteractionStore.getState().ready[environmentKey(env)] === true;
}
export function useCanAnswerInteraction(id: string | null | undefined): boolean {
	return useInteractionStore((state) => {
		if (!id) return false;
		const env = environmentEntityRef(id).environment;
		return env.kind === "local" || state.ready[environmentKey(env)] === true;
	});
}
export function invalidateInteractions(environment: EnvironmentRef): void {
	const key = environmentKey(environment);
	useInteractionStore.setState((state) => ({ ready: { ...state.ready, [key]: false } }));
	boundary.beginSessionBaseline(key);
}
export function acceptInteractionEvent(
	environment: EnvironmentRef,
	revision: number | undefined,
	payload: unknown,
	apply: () => void,
): void {
	if (environment.kind === "local") {
		apply();
		return;
	}
	if (revision === undefined) return;
	boundary.acceptSessionEvent(environmentKey(environment), revision, payload, apply);
}
export async function synchronizeInteractions(environment: EnvironmentRef): Promise<void> {
	const key = environmentKey(environment);
	const token = boundary.pendingSessionBaselineToken(key) ?? boundary.beginSessionBaseline(key);
	try {
		const snapshot = await getExecutionApi(environment).getPendingInteractions();
		boundary.finishSessionBaseline(key, token, snapshot.revision, () => install(environment, snapshot));
	} catch (error) {
		boundary.failSessionBaseline(key, token);
		throw error;
	}
}
function install(environment: EnvironmentRef, snapshot: PendingInteractions): void {
	const key = environmentKey(environment),
		belongs = (id: string) => environmentKey(environmentEntityRef(id).environment) === key;
	useTranscriptStore.setState((state) => {
		const next = { ...state.bySession };
		for (const [id, entry] of Object.entries(next))
			if (belongs(id)) next[id] = { ...entry, pendingPermissions: [], pendingDialogs: [] };
		return { bySession: next };
	});
	for (const request of snapshot.permissions)
		useTranscriptStore.getState().addPermission(request.sessionId, request);
	for (const request of snapshot.dialogs)
		useTranscriptStore.getState().addExtensionDialog(request.sessionId, request);
	useInteractionStore.setState((state) => ({
		trustRequests: [...state.trustRequests.filter((request) => !belongs(request.id)), ...snapshot.trust],
		ready: { ...state.ready, [key]: true },
	}));
}
