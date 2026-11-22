import {
	CHANNEL_TABLE,
	type EnvironmentApi,
	type EnvironmentRef,
	environmentInvocation,
	environmentRef,
	LOCAL_ENVIRONMENT,
	SUBSCRIPTION_TABLE,
	sameEnvironment,
} from "@percho/shared";

import { type EnvironmentIpc, installRemoteEventGate } from "./remote-event-gate";

type Listener = (event: unknown, payload: unknown, source?: unknown, metadata?: unknown) => void;

export function eventBelongsTo(source: unknown, environment: EnvironmentRef): boolean {
	try {
		return sameEnvironment(source === undefined ? LOCAL_ENVIRONMENT : environmentRef(source), environment);
	} catch {
		return false;
	}
}

/** Derived from the same tables as the legacy API; no extra business channel or reflective proxy. */
export function createEnvironmentApi(ipc: EnvironmentIpc, environment: EnvironmentRef): EnvironmentApi {
	const bound = environmentRef(environment);
	const gate = installRemoteEventGate(ipc, bound.kind === "ssh");
	const invoke = Object.fromEntries(
		Object.entries(CHANNEL_TABLE)
			.filter(([, def]) => def.scope === "environment")
			.map(([key, def]) => [
				key,
				(args: unknown) => ipc.invoke(def.channel, environmentInvocation(bound, args)),
			]),
	);
	const subscriptions = Object.fromEntries(
		Object.entries(SUBSCRIPTION_TABLE)
			.filter(([, def]) => def.scope === "environment")
			.map(([key, def]) => [
				key,
				(cb: (payload: unknown) => void) => {
					const listener: Listener = (_event, payload, source, metadata) => {
						if (eventBelongsTo(source, bound) && (bound.kind === "local" || gate.allows(bound, metadata))) {
							cb(payload);
						}
					};
					ipc.on(def.channel, listener);
					return () => ipc.removeListener(def.channel, listener);
				},
			]),
	);
	return { ...invoke, ...subscriptions } as EnvironmentApi;
}
