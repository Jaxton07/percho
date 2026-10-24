import {
	CHANNEL_TABLE,
	type EnvironmentApi,
	type EnvironmentMethod,
	type EnvironmentRef,
	environmentEntityId,
	environmentEntityKey,
	environmentEntityRef,
	environmentKey,
	environmentRef,
	extractSubagentRuns,
	type PiApi,
	type SessionMeta,
	SUBSCRIPTION_TABLE,
} from "@percho/shared";
import { getPi } from "./api";
import { getEnvironments, onEnvironmentsChanged } from "./environment-registry";

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only known navigation metadata is scoped. Third-party content and tool arguments stay literal. */
function subagentDetails(value: unknown, environment: EnvironmentRef): unknown {
	if (!record(value) || !extractSubagentRuns(value)) return value;
	const child = (item: unknown): unknown => {
		if (!record(item)) return item;
		const next = { ...item };
		if (typeof next.sessionFile === "string")
			next.sessionFile = environmentEntityKey(environment, next.sessionFile);
		if (record(next.artifactPaths)) {
			const paths = { ...next.artifactPaths };
			for (const key of ["jsonlPath", "outputPath"]) {
				if (typeof paths[key] === "string" && (key === "jsonlPath" || paths[key].endsWith(".jsonl"))) {
					paths[key] = environmentEntityKey(environment, paths[key]);
				}
			}
			next.artifactPaths = paths;
		}
		return next;
	};
	return {
		...value,
		...(Array.isArray(value.results) ? { results: value.results.map(child) } : {}),
		...(Array.isArray(value.completions)
			? {
					completions: value.completions.map((entry) =>
						record(entry) && Array.isArray(entry.results)
							? { ...entry, results: entry.results.map(child) }
							: entry,
					),
				}
			: {}),
	};
}

function toolResult(value: unknown, environment: EnvironmentRef): unknown {
	return record(value) && extractSubagentRuns(value.details)
		? { ...value, details: subagentDetails(value.details, environment) }
		: value;
}

export function scopeSessionMeta(value: SessionMeta, environment: EnvironmentRef): SessionMeta {
	return {
		...value,
		sessionId: environmentEntityKey(environment, value.sessionId),
		cwd: environmentEntityKey(environment, value.cwd),
		...(value.sessionFile ? { sessionFile: environmentEntityKey(environment, value.sessionFile) } : {}),
	};
}

function resultFor(method: string, value: unknown, environment: EnvironmentRef): unknown {
	if (value == null) return value;
	switch (method) {
		case "createSession":
		case "openSession":
		case "forkSession":
			return scopeSessionMeta(value as SessionMeta, environment);
		case "listSessions":
		case "listAllSessions":
			return (value as SessionMeta[]).map((meta) => scopeSessionMeta(meta, environment));
		case "getDailyDir":
			return environmentEntityKey(environment, value as string);
		case "getChannelSubscriptionSessionIds":
			return (value as string[]).map((id) => environmentEntityKey(environment, id));
		case "getChannelSubscriptions":
			return record(value) && typeof value.sessionId === "string"
				? { ...value, sessionId: environmentEntityKey(environment, value.sessionId) }
				: value;
		case "getSessionMessages":
			return (value as unknown[]).map((message) =>
				record(message) && message.role === "subagent" && Array.isArray(message.runs)
					? {
							...message,
							runs: message.runs.map((run) =>
								record(run) && typeof run.sessionFile === "string"
									? { ...run, sessionFile: environmentEntityKey(environment, run.sessionFile) }
									: run,
							),
						}
					: message,
			);
		default:
			return value;
	}
}

function eventFor(method: string, value: unknown, environment: EnvironmentRef): unknown {
	if (!record(value)) return value;
	const next = { ...value };
	for (const key of ["sessionId", "requestId"]) {
		if (typeof next[key] === "string") next[key] = environmentEntityKey(environment, next[key]);
	}
	if (
		["onPermissionRequest", "onExtensionDialogRequest", "onTrustRequest"].includes(method) &&
		typeof next.id === "string"
	) {
		next.id = environmentEntityKey(environment, next.id);
	}
	if (method === "onTrustRequest" && typeof next.cwd === "string")
		next.cwd = environmentEntityKey(environment, next.cwd);
	if (method === "onEvent" && record(next.event)) {
		const event = next.event;
		if (event.type === "tool_execution_update")
			next.event = { ...event, partialResult: toolResult(event.partialResult, environment) };
		else if (event.type === "tool_execution_end")
			next.event = { ...event, result: toolResult(event.result, environment) };
	}
	return next;
}

function argumentsFor(value: unknown, environment: EnvironmentRef): unknown {
	if (!record(value)) return value;
	const next = { ...value };
	for (const key of ["sessionId", "requestId", "sessionFile", "filePath"]) {
		if (typeof next[key] === "string") next[key] = environmentEntityId(environment, next[key]);
	}
	// Explicitly bound directory input may be literal (e.g. the add-project field).
	const directory = (cwd: string) =>
		cwd.startsWith("percho-env-v1:") ? environmentEntityId(environment, cwd) : cwd;
	if (typeof next.cwd === "string") next.cwd = directory(next.cwd);
	if (record(next.options) && typeof next.options.cwd === "string")
		next.options = { ...next.options, cwd: directory(next.options.cwd) };
	return next;
}

const cached = new WeakMap<PiApi, Map<string, EnvironmentApi>>();

/** Explicit target/ref only; selection and async completion never redirect this object. */
export function getExecutionApi(reference: EnvironmentRef | string): EnvironmentApi {
	const environment =
		typeof reference === "string" ? environmentEntityRef(reference).environment : environmentRef(reference);
	const pi = getPi();
	const key = environmentKey(environment);
	const pool = cached.get(pi) ?? new Map<string, EnvironmentApi>();
	cached.set(pi, pool);
	const existing = pool.get(key);
	if (existing) return existing;
	const raw = pi.forEnvironment(environment);
	const entries: Array<[string, unknown]> = Object.entries(CHANNEL_TABLE)
		.filter(([, def]) => def.scope === "environment")
		.map(([method]) => [
			method,
			async (args: unknown) => {
				const call = raw[method as EnvironmentMethod] as (input?: unknown) => Promise<unknown>;
				const value = args === undefined ? await call() : await call(argumentsFor(args, environment));
				return resultFor(method, value, environment);
			},
		]);
	for (const [method, def] of Object.entries(SUBSCRIPTION_TABLE)) {
		if (def.scope !== "environment") continue;
		entries.push([
			method,
			(cb: (payload: unknown) => void) => {
				const subscribe = raw[method as keyof EnvironmentApi] as (
					callback: (payload: unknown) => void,
				) => () => void;
				return subscribe((payload) => cb(eventFor(method, payload, environment)));
			},
		]);
	}
	const api = Object.fromEntries(entries) as EnvironmentApi;
	pool.set(key, api);
	return api;
}

/** Add/remove subscriptions by identity, retaining both sources without a global selected API. */
export function subscribeExecutionEnvironments(
	install: (api: EnvironmentApi, environment: EnvironmentRef) => () => void,
): () => void {
	const subscriptions = new Map<string, () => void>();
	const sync = () => {
		const wanted = new Set(getEnvironments().map(environmentKey));
		for (const [key, off] of subscriptions)
			if (!wanted.has(key)) {
				off();
				subscriptions.delete(key);
			}
		for (const environment of getEnvironments()) {
			const key = environmentKey(environment);
			if (!subscriptions.has(key)) subscriptions.set(key, install(getExecutionApi(environment), environment));
		}
	};
	sync();
	const off = onEnvironmentsChanged(sync);
	return () => {
		off();
		for (const dispose of subscriptions.values()) dispose();
		subscriptions.clear();
	};
}
