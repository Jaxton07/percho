import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ACTIVATION_EVENT = "percho:provider-activation:v1";

export type ProviderActivationRuntime = Pick<
	ModelRuntime,
	| "getRegisteredNativeProvider"
	| "getRegisteredProviderConfig"
	| "getProvider"
	| "getProviders"
	| "getModel"
	| "getModels"
	| "getAuth"
	| "registerNativeProvider"
	| "registerProvider"
	| "unregisterProvider"
	| "refresh"
> & { readonly signal: AbortSignal };
type ActivationHandle = { deactivate(): void | Promise<void> };
export interface ProviderActivation {
	version: 1;
	id: string;
	activate(runtime: ProviderActivationRuntime): ActivationHandle | Promise<ActivationHandle>;
}

/** 每代独占的激活句柄；撤销先同步生效，异步清理随后等待。 */
export class ProviderStartup {
	private readonly declarations: ProviderActivation[] = [];
	private readonly controller = new AbortController();
	private readonly handles: ActivationHandle[] = [];
	private readonly owned = new Map<string, { native: unknown; config: unknown; source?: string }>();
	private runtime?: ModelRuntime;
	private invalidate?: () => void;
	private cleanup: Promise<void> = Promise.resolve();
	private catalogFailures: string[] = [];
	private activating = true;

	constructor(private readonly coordinate: <T>(work: () => Promise<T>, signal?: AbortSignal) => Promise<T>) {}

	getDiagnostics(): { phase: "catalog"; providerId: string }[] {
		return this.catalogFailures.map((providerId) => ({ phase: "catalog", providerId }));
	}

	observeRefresh(result: Awaited<ReturnType<ModelRuntime["refresh"]>>): void {
		this.catalogFailures = [...result.errors.keys()];
	}

	collect(value: unknown): void {
		if (this.controller.signal.aborted || !value || typeof value !== "object") return;
		const candidate = value as Partial<ProviderActivation>;
		if (
			candidate.version !== 1 ||
			typeof candidate.id !== "string" ||
			!candidate.id.trim() ||
			typeof candidate.activate !== "function"
		)
			return;
		this.declarations.push(candidate as ProviderActivation);
	}

	private own(id: string, source?: string): void {
		this.owned.set(id, {
			source,
			native: this.runtime?.getRegisteredNativeProvider(id),
			config: this.runtime?.getRegisteredProviderConfig(id),
		});
	}

	private remove(id: string): void {
		const owner = this.owned.get(id);
		if (!owner || !this.runtime) return;
		this.owned.delete(id);
		if (
			(this.runtime.getRegisteredNativeProvider(id) === owner.native &&
				this.runtime.getRegisteredProviderConfig(id) === owner.config) ||
			(owner.source !== undefined && this.runtime.getRegisteredProviderSource(id) === owner.source)
		)
			this.runtime.unregisterProvider(id);
	}

	async activate(runtime: ModelRuntime): Promise<void> {
		this.runtime = runtime;
		const ids = new Set<string>();
		for (const declaration of this.declarations) {
			if (ids.has(declaration.id) || runtime.getProvider(declaration.id)) {
				throw new Error(`Provider activation conflict: ${declaration.id}`);
			}
			ids.add(declaration.id);
		}
		for (const declaration of this.declarations) {
			const assertActive = (id = declaration.id) => {
				if (this.controller.signal.aborted) throw new Error("Provider activation revoked");
				if (id !== declaration.id) throw new Error("Provider activation id mismatch");
			};
			assertActive();
			const handle = await declaration.activate({
				signal: this.controller.signal,
				getRegisteredNativeProvider: runtime.getRegisteredNativeProvider.bind(runtime),
				getRegisteredProviderConfig: runtime.getRegisteredProviderConfig.bind(runtime),
				getProvider: runtime.getProvider.bind(runtime),
				getProviders: runtime.getProviders.bind(runtime),
				getModel: runtime.getModel.bind(runtime),
				getModels: runtime.getModels.bind(runtime),
				getAuth: runtime.getAuth.bind(runtime),
				registerNativeProvider: (provider) => {
					assertActive(provider.id);
					runtime.registerNativeProvider(provider);
					this.own(provider.id);
				},
				registerProvider: (id, config) => {
					assertActive(id);
					runtime.registerProvider(id, config);
					this.own(id);
				},
				unregisterProvider: (id) => {
					if (id === declaration.id) this.remove(id);
				},
				refresh: async (options) => {
					// 清理可能由加载队列持有；已撤销请求必须在入队前拒绝。
					assertActive();
					const signal = AbortSignal.any([
						this.controller.signal,
						...(options?.signal ? [options.signal] : []),
					]);
					const work = () => {
						assertActive();
						return runtime.refresh({
							...options,
							providers: undefined,
							signal,
						});
					};
					// activate 已在宿主加载队列中；不能把它等待的 refresh 再排到自己后面。
					return this.activating ? work() : this.coordinate(work, signal);
				},
			});
			if (!handle || typeof handle.deactivate !== "function") {
				throw new Error("Provider activation handle is invalid");
			}
			this.handles.push(handle);
			if (this.controller.signal.aborted) {
				this.stop();
				return;
			}
		}
		// 全量刷新维持其他 provider 的 filterModels，不传 providers 子集。
		await runtime.refresh({ allowNetwork: false, signal: this.controller.signal });
		// SDK 注册的 void refresh 可能仍在读取配置；必须在在线发布前汇合。
		await runtime.settleRegistrationRefreshes();
		this.controller.signal.throwIfAborted();
		this.observeRefresh(
			await runtime.refresh({
				allowNetwork: true,
				signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)]),
			}),
		);
		this.activating = false;
	}

	/** SDK services 消费普通工厂注册后，记录实际实例而不是仅记录 id。 */
	adopt(runtime: ModelRuntime, registrations: ReadonlyMap<string, string>, invalidate: () => void): void {
		this.runtime = runtime;
		this.invalidate = invalidate;
		for (const [id, source] of registrations) this.own(id, source);
		if (this.controller.signal.aborted) this.stop();
	}

	stop(): void {
		this.controller.abort(new Error("Provider activation revoked"));
		this.invalidate?.();
		for (const id of this.owned.keys()) this.remove(id);
		const handles = this.handles.splice(0);
		this.cleanup = this.cleanup.then(async () => {
			await Promise.allSettled(handles.map((handle) => Promise.resolve().then(() => handle.deactivate())));
		});
	}

	async join(): Promise<void> {
		await this.cleanup;
	}
}
