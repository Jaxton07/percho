import { type EnvironmentRef, environmentKey, environmentRef, LOCAL_ENVIRONMENT } from "@percho/shared";

/** Available identities, not a selected backend. A disconnected target retains its identity. */
let available: readonly EnvironmentRef[] = [LOCAL_ENVIRONMENT];
const listeners = new Set<() => void>();

export function getEnvironments(): readonly EnvironmentRef[] {
	return available;
}

export function registerEnvironment(value: EnvironmentRef): () => void {
	const ref = environmentRef(value);
	if (ref.kind === "local") throw new Error("The local environment is already registered");
	if (available.length > 1) throw new Error("Only one remote environment may be registered");
	available = [LOCAL_ENVIRONMENT, ref];
	for (const notify of listeners) notify();
	return () => {
		if (!available.some((entry) => entry === ref)) return;
		available = [LOCAL_ENVIRONMENT];
		for (const notify of listeners) notify();
	};
}

export function onEnvironmentsChanged(notify: () => void): () => void {
	listeners.add(notify);
	return () => {
		listeners.delete(notify);
	};
}

export function isEnvironmentRegistered(ref: EnvironmentRef): boolean {
	return available.some((entry) => environmentKey(entry) === environmentKey(ref));
}
