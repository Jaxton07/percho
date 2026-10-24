import { type EnvironmentRef, environmentEntityRef, environmentKey } from "@percho/shared";

/** No event log: buffers only events arriving during one bounded baseline read. */
interface Boundary {
	generation: number;
	sequence: number;
	waiting: boolean;
	failed: boolean;
	bytes: number;
	pending: Array<{ sequence: number; apply: () => void }>;
}
export function createEventBoundary() {
	const pausedEnvironments = new Set<string>();
	function pauseEnvironmentEvents(environment: EnvironmentRef): void {
		pausedEnvironments.add(environmentKey(environment));
	}
	function resumeEnvironmentEvents(environment: EnvironmentRef): void {
		pausedEnvironments.delete(environmentKey(environment));
	}
	function isEnvironmentSynchronizing(environment: EnvironmentRef): boolean {
		return pausedEnvironments.has(environmentKey(environment));
	}
	const boundaries = new Map<string, Boundary>();
	const resetListeners = new Set<(sessionId: string) => void>();
	function forgetSessionBoundary(sessionId: string): void {
		boundaries.delete(sessionId);
		for (const reset of resetListeners) reset(sessionId);
	}
	function pendingSessionBaselineToken(sessionId: string): number | undefined {
		const state = boundaries.get(sessionId);
		return state?.waiting ? state.generation : undefined;
	}
	let generation = 0;
	function onSessionBoundaryReset(listener: (sessionId: string) => void): () => void {
		resetListeners.add(listener);
		return () => resetListeners.delete(listener);
	}
	function beginSessionBaseline(sessionId: string): number {
		const next = ++generation;
		boundaries.set(sessionId, {
			generation: next,
			sequence: 0,
			waiting: true,
			failed: false,
			bytes: 0,
			pending: [],
		});
		for (const reset of resetListeners) reset(sessionId);
		return next;
	}
	function isCurrentSessionBaseline(sessionId: string, token: number): boolean {
		return boundaries.get(sessionId)?.generation === token;
	}
	function isSessionSynchronizing(sessionId: string): boolean {
		const state = boundaries.get(sessionId);
		return state?.waiting === true || state?.failed === true;
	}
	function failSessionBaseline(sessionId: string, token: number): void {
		const state = boundaries.get(sessionId);
		if (state?.generation !== token) return;
		state.failed = true;
		state.pending = [];
		state.bytes = 0;
	}
	function finishSessionBaseline(
		sessionId: string,
		token: number,
		sequence: number,
		install: () => void,
	): boolean {
		const state = boundaries.get(sessionId);
		if (state?.generation !== token) return false;
		if (state.failed) throw new Error("Session synchronization buffer exceeded; retry this session");
		for (const reset of resetListeners) reset(sessionId);
		install();
		state.sequence = sequence;
		state.waiting = false;
		const pending = state.pending;
		state.pending = [];
		state.bytes = 0;
		for (const event of pending)
			if (event.sequence > state.sequence) {
				state.sequence = event.sequence;
				event.apply();
			}
		return true;
	}
	function acceptSessionEvent(
		sessionId: string,
		sequence: number | undefined,
		payload: unknown,
		apply: () => void,
	): void {
		if (sequence === undefined) {
			apply();
			return;
		}
		if (!Number.isSafeInteger(sequence) || sequence < 1) return;
		let state = boundaries.get(sessionId);
		if (!state && pausedEnvironments.has(environmentKey(environmentEntityRef(sessionId).environment))) {
			beginSessionBaseline(sessionId);
			state = boundaries.get(sessionId);
		}
		if (!state) {
			boundaries.set(sessionId, {
				generation: ++generation,
				sequence,
				waiting: false,
				failed: false,
				bytes: 0,
				pending: [],
			});
			apply();
			return;
		}
		if (state.failed || sequence <= state.sequence) return;
		if (state.waiting) {
			state.bytes += JSON.stringify(payload).length * 2;
			if (state.pending.length >= 8192 || state.bytes > 32 * 1024 * 1024) {
				state.failed = true;
				state.pending = [];
				state.bytes = 0;
				return;
			}
			state.pending.push({ sequence, apply });
			return;
		}
		state.sequence = sequence;
		apply();
	}

	return {
		pauseEnvironmentEvents,
		resumeEnvironmentEvents,
		isEnvironmentSynchronizing,
		forgetSessionBoundary,
		pendingSessionBaselineToken,
		onSessionBoundaryReset,
		beginSessionBaseline,
		isCurrentSessionBaseline,
		isSessionSynchronizing,
		failSessionBaseline,
		finishSessionBaseline,
		acceptSessionEvent,
	};
}
export const {
	pauseEnvironmentEvents,
	resumeEnvironmentEvents,
	isEnvironmentSynchronizing,
	forgetSessionBoundary,
	pendingSessionBaselineToken,
	onSessionBoundaryReset,
	beginSessionBaseline,
	isCurrentSessionBaseline,
	isSessionSynchronizing,
	failSessionBaseline,
	finishSessionBaseline,
	acceptSessionEvent,
} = createEventBoundary();
