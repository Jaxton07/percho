import {
	type EnvironmentRef,
	environmentKey,
	environmentRef,
	LOCAL_ENVIRONMENT,
	type McpConfigListResult,
	type McpGlobalNotice,
	type McpReloadReport,
	type McpRuntimeInventory,
	type McpServersChangedPayload,
	type McpUpsertInput,
	projectMcpRuntime,
} from "@percho/shared";
import { create, useStore } from "zustand";
import { getExecutionApi } from "../environment-api";
import { useEnvironment } from "../environment-context";
import { useToastsStore } from "./toasts";

interface McpStore {
	config: McpConfigListResult | null;
	loading: boolean;
	notice?: McpGlobalNotice;
	lastReload: McpReloadReport | null;
	selectedInstanceId: string | null | undefined;
	load: (cwd?: string, activeSessionId?: string) => Promise<void>;
	selectInstance: (id: string | null) => void;
	login: (name: string) => Promise<void>;
	upsert: (input: McpUpsertInput) => Promise<void>;
	importServers: (json: string, cwd?: string) => Promise<void>;
	remove: (input: { scope: "user" | "project"; cwd?: string; name: string }) => Promise<void>;
	reload: (cwd?: string) => Promise<void>;
	applyServersChanged: (payload: McpServersChangedPayload) => void;
}

function createMcpStore(environment: EnvironmentRef) {
	return create<McpStore>((set, get) => {
		let loadSeq = 0;
		let contextSeq = 0;
		let operationSeq = 0;
		let selectionSeq = 0;
		let reconcileFailedOperation: (() => Promise<void>) | undefined;
		// Concurrent IPC completion can install a newer recovery while this operation is awaiting.
		const reconcileAfterWrite = () => reconcileFailedOperation?.();
		const reconcileCurrentContext = () => reconcileAfterWrite() ?? get().load(contextCwd, activeSession);
		const retiredEpochs = new Set<string>();
		let contextCwd: string | undefined;
		let runtime: McpRuntimeInventory | undefined;
		let eventSeq = 0;
		let activeSession: string | undefined;
		const project = (config: McpConfigListResult) => {
			if (!runtime) return config;
			let selected = get().selectedInstanceId;
			if (selected === undefined && activeSession) {
				selected = runtime.instances.find(
					(instance) => instance.cwd === config.contextCwd && instance.sessionId === activeSession,
				)?.instanceId;
			}
			const result = projectMcpRuntime(config, runtime, selected);
			// Once selected, keep the identity even if the instance disappears.
			if (selected === undefined && result.selectedInstanceId) selected = result.selectedInstanceId;
			set({ selectedInstanceId: selected });
			return result;
		};
		const acceptBase = (incoming: McpRuntimeInventory | undefined, startedAt: number) => {
			if (!incoming) return;
			if (retiredEpochs.has(incoming.epoch)) return;
			if (
				runtime &&
				((runtime.epoch === incoming.epoch && runtime.revision > incoming.revision) ||
					(runtime.epoch !== incoming.epoch && eventSeq !== startedAt))
			)
				return;
			if (runtime && runtime.epoch !== incoming.epoch) retiredEpochs.add(runtime.epoch);
			runtime = incoming;
		};
		const commit = (config: McpConfigListResult) => {
			const projected = project(config);
			set({ config: projected, notice: projected.notice });
		};
		const mutationSelection = () => {
			const id = get().selectedInstanceId;
			const instance = runtime?.instances.find(
				(item) => item.instanceId === id && item.cwd === get().config?.contextCwd,
			);
			return { id, sessionId: instance?.sessionId, cwd: get().config?.contextCwd, selectionSeq };
		};
		const followMutation = (selection: ReturnType<typeof mutationSelection>) => {
			if (
				selection.selectionSeq !== selectionSeq ||
				!selection.sessionId ||
				get().selectedInstanceId !== selection.id ||
				get().config?.contextCwd !== selection.cwd
			)
				return;
			const next = runtime?.instances.find(
				(item) => item.cwd === selection.cwd && item.sessionId === selection.sessionId,
			);
			if (next) set({ selectedInstanceId: next.instanceId });
		};
		const mutate = async (
			request: () => Promise<{ config: McpConfigListResult; reload: McpReloadReport }>,
		) => {
			const seq = contextSeq;
			const operation = ++operationSeq;
			reconcileFailedOperation = undefined;
			const startedAt = eventSeq;
			const selection = mutationSelection();
			const cwd = contextCwd;
			const current = () => seq === contextSeq && operation === operationSeq;
			const recover = async () => {
				if (!current()) return;
				const read = ++loadSeq;
				try {
					const recoveryStartedAt = eventSeq;
					const config = await getExecutionApi(environment).mcpConfigList({ cwd });
					if (current() && read === loadSeq) {
						acceptBase(config.runtime, recoveryStartedAt);
						followMutation(selection);
						commit(config);
						set({ loading: false });
					}
				} catch {
					// Failed reads also finish their generation; otherwise the invalidated load stays busy.
					if (current() && read === loadSeq) set({ loading: false });
					// Keep the mutation's original failure; another pending write may trigger reconciliation.
				}
			};
			let result: { config: McpConfigListResult; reload: McpReloadReport };
			try {
				result = await request();
			} catch (error) {
				if (current()) reconcileFailedOperation = recover;
				await reconcileCurrentContext();
				throw error;
			}
			if (!current()) {
				// A later preflight can fail before this earlier write lands. Re-read after it settles,
				// rather than discard the only evidence that the persisted configuration changed.
				await reconcileCurrentContext();
				return;
			}
			// Acknowledged writes supersede any reads that began before they completed.
			loadSeq++;
			acceptBase(result.config.runtime, startedAt);
			followMutation(selection);
			commit(result.config);
			set({ lastReload: result.reload, loading: false });
		};
		return {
			config: null,
			loading: false,
			lastReload: null,
			selectedInstanceId: undefined,
			load: async (cwd, sessionId) => {
				const seq = ++loadSeq;
				const operation = operationSeq;
				if (contextSeq === 0 || contextCwd !== cwd || activeSession !== sessionId) {
					contextSeq++;
					reconcileFailedOperation = undefined;
					contextCwd = cwd;
					activeSession = sessionId;
					set({ config: null, notice: undefined, selectedInstanceId: undefined });
				}
				const startedAt = eventSeq;
				set({ loading: true });
				try {
					const config = await getExecutionApi(environment).mcpConfigList({ cwd });
					if (seq !== loadSeq) return;
					if (operation !== operationSeq) {
						set({ loading: false });
						return;
					}
					acceptBase(config.runtime, startedAt);
					commit(config);
					set({ loading: false });
				} catch (error) {
					if (seq !== loadSeq) return;
					set({ loading: false });
					useToastsStore.getState().push("error", "toast.mcpLoadFailed");
					console.error("MCP 配置读取失败", error);
				}
			},
			selectInstance: (id) => {
				selectionSeq++;
				set({ selectedInstanceId: id });
				const config = get().config;
				if (config) commit(config);
			},
			login: async (name) => {
				const instanceId = get().selectedInstanceId;
				if (!instanceId) throw new Error("MCP instance is not selected");
				await getExecutionApi(environment).mcpLogin({ instanceId, name });
			},
			upsert: (input) => mutate(() => getExecutionApi(environment).mcpConfigUpsert(input)),
			importServers: (json, cwd) => mutate(() => getExecutionApi(environment).mcpConfigImport({ json, cwd })),
			remove: (input) => mutate(() => getExecutionApi(environment).mcpConfigRemove(input)),
			reload: (cwd) => mutate(() => getExecutionApi(environment).mcpConfigReload({ cwd })),
			applyServersChanged: (payload) => {
				if (
					retiredEpochs.has(payload.epoch) ||
					(runtime?.epoch === payload.epoch && runtime.revision >= payload.revision)
				)
					return;
				if (runtime && runtime.epoch !== payload.epoch) retiredEpochs.add(runtime.epoch);
				eventSeq++;
				runtime = payload;
				const config = get().config;
				if (config) commit(config);
			},
		};
	});
}

const stores = new Map<string, ReturnType<typeof createMcpStore>>();
export function getMcpStore(reference: EnvironmentRef = LOCAL_ENVIRONMENT) {
	const environment = environmentRef(reference);
	const key = environmentKey(environment);
	let store = stores.get(key);
	if (!store) {
		store = createMcpStore(environment);
		stores.set(key, store);
	}
	return store;
}
const localStore = getMcpStore();
export const useLocalMcpStore = localStore;
function useBoundMcpStore<T = McpStore>(selector?: (state: McpStore) => T): T {
	const store = getMcpStore(useEnvironment());
	return useStore(store, selector ?? ((state) => state as unknown as T));
}
export const useMcpStore = Object.assign(useBoundMcpStore, localStore);
