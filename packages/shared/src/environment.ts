/** Stable execution identity. Connection/instance epochs are transport state, never UI identity. */
export type EnvironmentRef =
	| { readonly kind: "local" }
	| { readonly kind: "ssh"; readonly connectionId: string; readonly environmentId: string };

export const LOCAL_ENVIRONMENT: EnvironmentRef = Object.freeze({ kind: "local" });

function identity(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
	for (const character of value) if (character.charCodeAt(0) < 32) return false;
	return true;
}

/** Copy before binding: mutating a caller-owned object must not redirect an in-flight operation. */
export function environmentRef(value: unknown): EnvironmentRef {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid execution environment");
	}
	const ref = value as Record<string, unknown>;
	if (ref.kind === "local" && Object.keys(ref).length === 1) return LOCAL_ENVIRONMENT;
	if (
		ref.kind === "ssh" &&
		Object.keys(ref).length === 3 &&
		identity(ref.connectionId) &&
		identity(ref.environmentId)
	) {
		return Object.freeze({ kind: "ssh", connectionId: ref.connectionId, environmentId: ref.environmentId });
	}
	throw new Error("Invalid execution environment");
}

export function environmentKey(value: EnvironmentRef): string {
	const ref = environmentRef(value);
	return ref.kind === "local" ? "local" : JSON.stringify(["ssh", ref.connectionId, ref.environmentId]);
}

export function sameEnvironment(left: EnvironmentRef, right: EnvironmentRef): boolean {
	return environmentKey(left) === environmentKey(right);
}

export interface EnvironmentEntityRef {
	readonly environment: EnvironmentRef;
	readonly id: string;
}

const ENTITY_PREFIX = "percho-env-v1:";

/** Legacy local values stay valid; reserved-prefix local values are escaped like remote values. */
export function environmentEntityKey(environment: EnvironmentRef, id: string): string {
	if (typeof id !== "string" || !id) throw new Error("Missing environment entity identity");
	const ref = environmentRef(environment);
	if (ref.kind === "local" && !id.startsWith(ENTITY_PREFIX)) return id;
	return ENTITY_PREFIX + encodeURIComponent(JSON.stringify([ref, id]));
}

export function environmentEntityRef(key: string): EnvironmentEntityRef {
	if (!key.startsWith(ENTITY_PREFIX)) return { environment: LOCAL_ENVIRONMENT, id: key };
	const tuple: unknown = JSON.parse(decodeURIComponent(key.slice(ENTITY_PREFIX.length)));
	if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[1] !== "string" || !tuple[1]) {
		throw new Error("Invalid environment entity identity");
	}
	return { environment: environmentRef(tuple[0]), id: tuple[1] };
}

export function environmentEntityId(environment: EnvironmentRef, key: string): string {
	const ref = environmentEntityRef(key);
	if (!sameEnvironment(ref.environment, environment)) {
		throw new Error("Entity belongs to a different execution environment");
	}
	return ref.id;
}

export interface EnvironmentInvocation {
	readonly __perchoEnvironment: 1;
	readonly environment: EnvironmentRef;
	readonly args: unknown;
}

export function isEnvironmentInvocation(value: unknown): value is EnvironmentInvocation {
	return !!value && typeof value === "object" && "__perchoEnvironment" in value;
}

export function environmentInvocation(environment: EnvironmentRef, args: unknown): EnvironmentInvocation {
	return { __perchoEnvironment: 1, environment: environmentRef(environment), args };
}
