import { CHANNEL_TABLE, type EnvironmentRef, SUBSCRIPTION_TABLE, sameEnvironment } from "@percho/shared";

type Listener = (event: unknown, payload: unknown, source?: unknown, metadata?: unknown) => void;
export interface EnvironmentIpc {
	invoke(channel: string, args: unknown): Promise<unknown>;
	on(channel: string, listener: Listener): unknown;
	removeListener(channel: string, listener: Listener): unknown;
}

type Gate = { allows: (environment: EnvironmentRef, metadata: unknown) => boolean; prime: () => void };
const gates = new WeakMap<EnvironmentIpc, Gate>();

/** One status observer and baseline per IPC instance, installed before exposing the API. */
export function installRemoteEventGate(ipc: EnvironmentIpc, queryBaseline = true): Gate {
	const existing = gates.get(ipc);
	if (existing) {
		if (queryBaseline) existing.prime();
		return existing;
	}
	let status: unknown;
	let observed = false;
	const accept = (next: unknown) => {
		if (!next || typeof next !== "object") return;
		const candidate = next as Record<string, unknown>;
		if (
			typeof candidate.epoch !== "string" ||
			!candidate.epoch ||
			!Number.isSafeInteger(candidate.generation) ||
			(candidate.generation as number) < 0 ||
			!Number.isSafeInteger(candidate.revision)
		)
			return;
		if (status && typeof status === "object") {
			const previous = status as Record<string, unknown>;
			if (
				candidate.epoch !== previous.epoch ||
				(candidate.revision as number) <= (previous.revision as number)
			)
				return;
		}
		status = next;
	};
	let requested = false;
	const gate: Gate = {
		prime() {
			if (requested) return;
			requested = true;
			void ipc.invoke(CHANNEL_TABLE.remoteGetStatus.channel, undefined).then(
				(baseline) => {
					if (!observed) accept(baseline);
				},
				() => {
					requested = false;
				},
			);
		},
		allows(environment, metadata) {
			if (!status || typeof status !== "object" || !metadata || typeof metadata !== "object") return false;
			const current = status as Record<string, unknown>;
			const boundary = metadata as Record<string, unknown>;
			if (
				current.state !== "connected" ||
				typeof current.epoch !== "string" ||
				typeof current.generation !== "number" ||
				current.epoch !== boundary.epoch ||
				current.generation !== boundary.generation ||
				environment.kind !== "ssh" ||
				current.connectionId !== environment.connectionId
			)
				return false;
			try {
				return sameEnvironment(current.environment as EnvironmentRef, environment);
			} catch {
				return false;
			}
		},
	};
	gates.set(ipc, gate);
	ipc.on(SUBSCRIPTION_TABLE.onRemoteConnectionStatus.channel, (_event, next) => {
		observed = true;
		accept(next);
	});
	if (queryBaseline) gate.prime();
	return gate;
}
