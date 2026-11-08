import {
	type EnvironmentRef,
	environmentKey,
	type SessionCatalogChange,
	type SessionCatalogPage,
	type SessionCatalogProjects,
	type SessionCatalogQuery,
} from "@percho/shared";
import { create } from "zustand";
import { getExecutionApi } from "../environment-api";

export interface CatalogPageState extends SessionCatalogPage {
	query: SessionCatalogQuery;
	loading: boolean;
	error?: string;
}
export interface CatalogEnvironmentState {
	projects: SessionCatalogProjects | undefined;
	loading: boolean;
	error?: string;
	pages: Record<string, CatalogPageState>;
}
interface CatalogStore {
	byEnvironment: Record<string, CatalogEnvironmentState>;
	loadProjects: (environment: EnvironmentRef) => Promise<void>;
	loadPage: (
		environment: EnvironmentRef,
		query: SessionCatalogQuery,
		append?: boolean,
		preserve?: boolean,
	) => Promise<void>;
	watch: (environment: EnvironmentRef) => () => void;
	invalidate: (environment: EnvironmentRef) => void;
	retainSidebarSearch: (search: string) => void;
	clear: (environment?: EnvironmentRef) => void;
}

export const EMPTY_CATALOG_ENVIRONMENT: CatalogEnvironmentState = {
	projects: undefined,
	loading: false,
	pages: {},
};
export function sessionCatalogPageKey(query: SessionCatalogQuery): string {
	return JSON.stringify([
		query.cwd ?? null,
		query.search ?? null,
		query.archived ?? null,
		query.sort ?? null,
	]);
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
// The IPC table is being extended separately. Validate each capability at runtime until it lands.
function projectsApi(
	value: unknown,
): value is { querySessionProjects: () => Promise<SessionCatalogProjects> } {
	return (
		typeof value === "object" &&
		value !== null &&
		"querySessionProjects" in value &&
		typeof value.querySessionProjects === "function"
	);
}
function pageApi(
	value: unknown,
): value is { querySessionCatalog: (input: { query: SessionCatalogQuery }) => Promise<SessionCatalogPage> } {
	return (
		typeof value === "object" &&
		value !== null &&
		"querySessionCatalog" in value &&
		typeof value.querySessionCatalog === "function"
	);
}
function watchApi(
	value: unknown,
): value is { onSessionCatalogChanged: (handler: (change: SessionCatalogChange) => void) => () => void } {
	return (
		typeof value === "object" &&
		value !== null &&
		"onSessionCatalogChanged" in value &&
		typeof value.onSessionCatalogChanged === "function"
	);
}

type Watch = { refs: number; off: () => void; last?: string; timer?: ReturnType<typeof setTimeout> };
export const useSessionCatalogStore = create<CatalogStore>((set, get) => {
	let sequence = 0;
	const requests = new Map<string, number>();
	const watches = new Map<string, Watch>();
	const request = (key: string) => {
		const id = ++sequence;
		requests.set(key, id);
		return id;
	};
	const update = (key: string, fn: (state: CatalogEnvironmentState) => CatalogEnvironmentState) =>
		set((state) => ({
			byEnvironment: {
				...state.byEnvironment,
				[key]: fn(state.byEnvironment[key] ?? EMPTY_CATALOG_ENVIRONMENT),
			},
		}));
	const refresh = (environment: EnvironmentRef) => {
		const key = environmentKey(environment);
		const pages = Object.values(get().byEnvironment[key]?.pages ?? {});
		void get().loadProjects(environment);
		for (const page of pages) void get().loadPage(environment, page.query, false, true);
	};
	return {
		byEnvironment: {},
		loadProjects: async (environment) => {
			const key = environmentKey(environment);
			const tokenKey = JSON.stringify([key, "projects"]);
			const token = request(tokenKey);
			update(key, (state) => ({ ...state, loading: true, error: undefined }));
			try {
				const api = getExecutionApi(environment);
				if (!projectsApi(api)) throw new Error("Execution environment does not support querySessionProjects");
				const projects = await api.querySessionProjects();
				if (requests.get(tokenKey) === token)
					update(key, (state) => ({ ...state, projects, loading: false }));
			} catch (error) {
				if (requests.get(tokenKey) === token)
					update(key, (state) => ({ ...state, loading: false, error: errorMessage(error) }));
			}
		},
		loadPage: async (environment, query, append = false, preserve = false) => {
			const key = environmentKey(environment);
			const pageKey = sessionCatalogPageKey(query);
			const tokenKey = JSON.stringify([key, "page", pageKey]);
			const old = get().byEnvironment[key]?.pages[pageKey];
			if (append && (!old?.nextCursor || old.loading)) return;
			const { cursor: _cursor, limit, ...base } = query;
			const normalized = { ...base, limit: limit ?? 6 };
			const token = request(tokenKey);
			// Retain the unfiltered page and only the latest search for each project and sort.
			if (query.search) {
				for (const [otherKey, page] of Object.entries(get().byEnvironment[key]?.pages ?? {})) {
					if (
						otherKey !== pageKey &&
						page.query.search &&
						page.query.cwd === query.cwd &&
						page.query.archived === query.archived &&
						page.query.sort === query.sort
					) {
						requests.delete(JSON.stringify([key, "page", otherKey]));
						update(key, (state) => {
							const pages = { ...state.pages };
							delete pages[otherKey];
							return { ...state, pages };
						});
					}
				}
			}
			const initial: CatalogPageState = old ?? {
				query: normalized,
				sessions: [],
				revision: "",
				complete: false,
				errors: 0,
				loading: false,
			};
			update(key, (state) => ({
				...state,
				pages: {
					...state.pages,
					[pageKey]: { ...initial, query: normalized, loading: true, error: undefined },
				},
			}));
			const active = () => requests.get(tokenKey) === token;
			try {
				const api = getExecutionApi(environment);
				if (!pageApi(api)) throw new Error("Execution environment does not support querySessionCatalog");
				let result: SessionCatalogPage;
				let shouldAppend = append;
				try {
					result = await api.querySessionCatalog({
						query: append ? { ...base, limit: 16, cursor: old?.nextCursor } : normalized,
					});
				} catch (error) {
					if (!append || !/stale/i.test(errorMessage(error))) throw error;
					if (!active()) return;
					shouldAppend = false;
					result = await api.querySessionCatalog({ query: normalized });
				}
				if (!active()) return;
				if (!shouldAppend && preserve && old) {
					const target = Math.max(normalized.limit, old.sessions.length);
					while (result.nextCursor && result.sessions.length < target) {
						const next = await api.querySessionCatalog({
							query: {
								...base,
								limit: Math.min(100, target - result.sessions.length),
								cursor: result.nextCursor,
							},
						});
						if (!active()) return;
						if (next.revision !== result.revision) throw new Error("CATALOG_STALE_CURSOR");
						result = { ...next, sessions: [...result.sessions, ...next.sessions] };
					}
				}
				if (shouldAppend && result.revision !== old?.revision) {
					shouldAppend = false;
					result = await api.querySessionCatalog({ query: normalized });
					if (!active()) return;
				}
				update(key, (state) => ({
					...state,
					pages: {
						...state.pages,
						[pageKey]: {
							...result,
							sessions: shouldAppend ? [...initial.sessions, ...result.sessions] : result.sessions,
							query: normalized,
							loading: false,
						},
					},
				}));
			} catch (error) {
				if (active())
					update(key, (state) => ({
						...state,
						pages: {
							...state.pages,
							[pageKey]: { ...initial, ...state.pages[pageKey], loading: false, error: errorMessage(error) },
						},
					}));
			}
		},
		watch: (environment) => {
			const key = environmentKey(environment);
			let watch = watches.get(key);
			if (watch) watch.refs++;
			else {
				watch = { refs: 1, off: () => {} };
				watches.set(key, watch);
				const entry = watch;
				try {
					const api = getExecutionApi(environment);
					if (!watchApi(api))
						throw new Error("Execution environment does not support onSessionCatalogChanged");
					entry.off = api.onSessionCatalogChanged((change) => {
						if (watches.get(key) !== entry) return;
						const signature = JSON.stringify([change.revision, change.complete]);
						if (entry.last === signature) return;
						entry.last = signature;
						if (entry.timer) return;
						entry.timer = setTimeout(() => {
							entry.timer = undefined;
							if (watches.get(key) === entry) refresh(environment);
						}, 150);
					});
					void get().loadProjects(environment);
				} catch (error) {
					watches.delete(key);
					update(key, (state) => ({ ...state, loading: false, error: errorMessage(error) }));
				}
			}
			const entry = watch;
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				if (watches.get(key) !== entry) return;
				if (--entry.refs === 0) {
					watches.delete(key);
					clearTimeout(entry.timer);
					entry.off();
				}
			};
		},
		invalidate: (environment) => refresh(environment),
		retainSidebarSearch: (search) => {
			for (const [key, state] of Object.entries(get().byEnvironment)) {
				const stale = Object.entries(state.pages).filter(
					([, page]) =>
						page.query.cwd &&
						page.query.archived === false &&
						page.query.search &&
						page.query.search !== search,
				);
				if (!stale.length) continue;
				for (const [pageKey] of stale) requests.delete(JSON.stringify([key, "page", pageKey]));
				update(key, (current) => {
					const pages = { ...current.pages };
					for (const [pageKey] of stale) delete pages[pageKey];
					return { ...current, pages };
				});
			}
		},
		clear: (environment) => {
			const keys = environment
				? [environmentKey(environment)]
				: [...new Set([...Object.keys(get().byEnvironment), ...watches.keys()])];
			for (const key of keys) {
				const watch = watches.get(key);
				watches.delete(key);
				clearTimeout(watch?.timer);
				watch?.off();
				for (const tokenKey of requests.keys())
					if (JSON.parse(tokenKey)[0] === key) requests.delete(tokenKey);
			}
			set((state) => {
				const next = { ...state.byEnvironment };
				for (const key of keys) delete next[key];
				return { byEnvironment: next };
			});
		},
	};
});
