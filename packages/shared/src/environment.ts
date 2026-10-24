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

/** JSON tuples preserve arbitrary SDK IDs and literal paths without delimiter collisions. */
export function environmentEntityKey(environment: EnvironmentRef, id: string): string {
	if (typeof id !== "string" || !id) throw new Error("Missing environment entity identity");
	return JSON.stringify([environmentKey(environment), id]);
}

export function environmentEntityId(environment: EnvironmentRef, key: string): string {
	const tuple: unknown = JSON.parse(key);
	if (
		!Array.isArray(tuple) ||
		tuple.length !== 2 ||
		tuple[0] !== environmentKey(environment) ||
		typeof tuple[1] !== "string" ||
		!tuple[1]
	) {
		throw new Error("Entity belongs to a different execution environment");
	}
	return tuple[1];
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
