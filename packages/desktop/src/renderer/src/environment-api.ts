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
	isReferenceImage,
	type PiApi,
	type SessionMeta,
	SUBSCRIPTION_TABLE,
} from "@percho/shared";
import { getPi } from "./api";
import { getEnvironments, onEnvironmentsChanged } from "./environment-registry";
import { isEnvironmentSynchronizing, isSessionSynchronizing } from "./stores/session-event-boundary";

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

function imageFor(value: unknown, environment: EnvironmentRef): unknown {
	return isReferenceImage(value)
		? { ...value, ownerSessionId: environmentEntityKey(environment, value.ownerSessionId) }
		: value;
}
function imageMessage<T>(value: T, environment: EnvironmentRef): T {
	if (!record(value)) return value;
	return {
		...value,
		...(Array.isArray(value.images)
			? { images: value.images.map((image) => imageFor(image, environment)) }
			: {}),
		...(typeof value.ownerSessionId === "string"
			? { ownerSessionId: environmentEntityKey(environment, value.ownerSessionId) }
			: {}),
	} as T;
}
function subagentRun(value: import("@percho/shared").SubagentRunUi, environment: EnvironmentRef) {
	return {
		...value,
		...(value.sessionFile ? { sessionFile: environmentEntityKey(environment, value.sessionFile) } : {}),
	};
}
function historyMessage(value: import("@percho/shared").UIMessage, environment: EnvironmentRef) {
	return imageMessage(
		value.kind === "subagent"
			? { ...value, runs: value.runs.map((run) => subagentRun(run, environment)) }
			: value,
		environment,
	);
}
function toolResult(value: unknown, environment: EnvironmentRef): unknown {
	if (!record(value) || !record(value.details)) return value;
	const details = value.details;
	return {
		...value,
		details: subagentDetails(
			{
				...details,
				...(Array.isArray(details.images)
					? { images: details.images.map((image) => imageFor(image, environment)) }
					: {}),
				...(details.image ? { image: imageFor(details.image, environment) } : {}),
			},
			environment,
		),
	};
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
		case "querySessionCatalog": {
			const page = value as import("@percho/shared").SessionCatalogPage;
			return { ...page, sessions: page.sessions.map((meta) => scopeSessionMeta(meta, environment)) };
		}
		case "querySessionProjects": {
			const result = value as import("@percho/shared").SessionCatalogProjects;
			return {
				...result,
				projects: result.projects.map((project) => ({
					...project,
					cwd: environmentEntityKey(environment, project.cwd),
				})),
			};
		}
		case "verifySessionCatalog":
			return (value as import("@percho/shared").SessionCatalogVerification[]).map((item) => ({
				...item,
				reference: {
					...item.reference,
					...(item.reference.sessionId
						? { sessionId: environmentEntityKey(environment, item.reference.sessionId) }
						: {}),
					...(item.reference.sessionFile
						? { sessionFile: environmentEntityKey(environment, item.reference.sessionFile) }
						: {}),
				},
				...(item.meta ? { meta: scopeSessionMeta(item.meta, environment) } : {}),
			}));
		case "archiveSession":
		case "unarchiveSession": {
			const result = value as import("@percho/shared").SessionArchiveResult;
			return {
				...result,
				sessionId: environmentEntityKey(environment, result.sessionId),
				sessionFile: environmentEntityKey(environment, result.sessionFile),
			};
		}
		case "previewSessionProjectDeletion": {
			const result = value as import("@percho/shared").SessionProjectDeletionPreview;
			return { ...result, cwd: environmentEntityKey(environment, result.cwd) };
		}
		case "deleteSessionProject": {
			const result = value as import("@percho/shared").SessionProjectDeletionResult;
			return {
				...result,
				deleted: result.deleted.map((id) => environmentEntityKey(environment, id)),
				failed: result.failed.map((item) => ({
					...item,
					sessionId: environmentEntityKey(environment, item.sessionId),
				})),
			};
		}
		case "getDailyDir":
			return environmentEntityKey(environment, value as string);
		case "getChannelSubscriptionSessionIds":
			return (value as string[]).map((id) => environmentEntityKey(environment, id));
		case "getChannelSubscriptions":
			return record(value) && typeof value.sessionId === "string"
				? { ...value, sessionId: environmentEntityKey(environment, value.sessionId) }
				: value;
		case "getPendingInteractions": {
			const snapshot = value as import("@percho/shared").PendingInteractions;
			return {
				...snapshot,
				permissions: snapshot.permissions.map((item) => eventFor("onPermissionRequest", item, environment)),
				dialogs: snapshot.dialogs.map((item) => eventFor("onExtensionDialogRequest", item, environment)),
				trust: snapshot.trust.map((item) => eventFor("onTrustRequest", item, environment)),
			};
		}
		case "getLoadedSessions":
			return (value as Array<{ meta: SessionMeta }>).map((item) => ({
				...item,
				meta: scopeSessionMeta(item.meta, environment),
			}));
		case "getSessionBaseline": {
			const baseline = value as import("@percho/shared").SessionBaseline;
			return {
				...baseline,
				meta: scopeSessionMeta(baseline.meta, environment),
				transcript: {
					...baseline.transcript,
					messages: baseline.transcript.messages.map((message) => historyMessage(message, environment)),
					streaming: baseline.transcript.streaming
						? {
								...baseline.transcript.streaming,
								subagentRuns: baseline.transcript.streaming.subagentRuns.map((run) =>
									subagentRun(run, environment),
								),
								pendingImages: baseline.transcript.streaming.pendingImages.map((images) =>
									imageMessage(images, environment),
								),
							}
						: null,
				},
			};
		}

		case "getSessionHistoryPage": {
			const page = value as import("@percho/shared").SessionHistoryPage;
			return { ...page, messages: page.messages.map((message) => historyMessage(message, environment)) };
		}
		case "getSessionMessages":
			return (value as unknown[]).map((message) =>
				imageMessage(
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
					environment,
				),
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
	if (["onTrustRequest", "onExtensionDialogRequest"].includes(method) && typeof next.cwd === "string")
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

function argumentsFor(method: string, value: unknown, environment: EnvironmentRef): unknown {
	if (!record(value)) return value;
	const next = { ...value };
	for (const key of ["sessionId", "sessionFile", "filePath"]) {
		if (typeof next[key] === "string") next[key] = environmentEntityId(environment, next[key]);
	}
	// Interaction handles are scoped entities; maintenance request IDs are opaque idempotency keys.
	if (
		["respondPermission", "respondTrust", "respondExtensionDialog"].includes(method) &&
		typeof next.requestId === "string"
	)
		next.requestId = environmentEntityId(environment, next.requestId);
	// Explicitly bound directory input may be literal (e.g. the add-project field).
	const directory = (cwd: string) =>
		cwd.startsWith("percho-env-v1:") ? environmentEntityId(environment, cwd) : cwd;
	if (method === "querySessionCatalog" && record(next.query) && typeof next.query.cwd === "string")
		next.query = { ...next.query, cwd: directory(next.query.cwd) };
	if (method === "verifySessionCatalog" && Array.isArray(next.references))
		next.references = next.references.map((reference) => {
			if (!record(reference)) return reference;
			return {
				...reference,
				...(typeof reference.sessionId === "string"
					? { sessionId: environmentEntityId(environment, reference.sessionId) }
					: {}),
				...(typeof reference.sessionFile === "string"
					? { sessionFile: environmentEntityId(environment, reference.sessionFile) }
					: {}),
			};
		});
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
				if (environment.kind === "ssh") {
					const definition = CHANNEL_TABLE[method as EnvironmentMethod];
					const controls = [
						"abort",
						"respondPermission",
						"respondTrust",
						"respondExtensionDialog",
						"markSessionHistoryReady",
						"setViewedSubagent",
					];
					if (
						definition.operation === "mutation" &&
						isEnvironmentSynchronizing(environment) &&
						!controls.includes(method)
					)
						throw new Error("Remote environment is synchronizing; wait before submitting new work");
					if (
						["prompt", "retryLastFailedTurn"].includes(method) &&
						record(args) &&
						typeof args.sessionId === "string" &&
						isSessionSynchronizing(args.sessionId)
					)
						throw new Error("Remote session is synchronizing; wait before submitting new work");
				}
				const call = raw[method as EnvironmentMethod] as (input?: unknown) => Promise<unknown>;
				if (typeof call !== "function") throw new Error(`Execution environment does not support ${method}`);
				const value = args === undefined ? await call() : await call(argumentsFor(method, args, environment));
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
				if (typeof subscribe !== "function")
					throw new Error(`Execution environment does not support ${method}`);
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
