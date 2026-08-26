import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	CustomProviderInput,
	CustomProviderUpdateInput,
	ListProvidersOptions,
	ProviderInfo,
	ProviderTestResult,
} from "@percho/shared";
import { JsonStore } from "../json-store";

/** 内置 provider id 集合：models.json 里配置的 ID 命中它 = 「覆写内置」（有官方模型列表可共享），否则是全新自定义 provider */
const BUILTIN_PROVIDER_IDS = new Set(builtinProviders().map((p) => p.id));

/** percho 表单管理的字段（用户输入决定，可被清空删除）；其余顶层字段（pi 手写的 apiKey/headers/compat 等）更新时保留，防编辑丢配置 */
const MANAGED_PROVIDER_FIELDS = ["name", "baseUrl", "api", "models"] as const;

type JsonObject = Record<string, unknown>;

/** 联网刷新模型目录的整体超时（SDK fetchWithRetry 默认无超时，网络不可达时会一直挂） */
const NETWORK_REFRESH_TIMEOUT_MS = 15_000;

/** models.json 支持 JSONC 注释；写入时统一输出纯 JSON */
function stripJsonComments(raw: string): string {
	return raw.replace(/\/\/[^\n"]*(?=\n)/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** auth/models 的 JsonStore：JSONC 读侧 + 损坏时 read 回退 {}（写入拒损坏由 update 保证） */
function jsonStoreFor(path: string, mode?: number): JsonStore<JsonObject> {
	return new JsonStore<JsonObject>({
		path,
		defaultValue: () => ({}),
		mode,
		parse: (raw) => JSON.parse(stripJsonComments(raw)) as JsonObject,
	});
}

/** 纯读（损坏/缺失回退 {}）；写路径一律走 jsonStoreFor(...).update —— 损坏拒写防全量配置丢失 */
async function readJsonFile(path: string): Promise<JsonObject> {
	return jsonStoreFor(path).read();
}

/**
 * Provider / 模型可视化配置服务。
 * auth.json 与 models.json 由 pi 读取（本服务负责写入），
 * 写完统一经 ModelRuntime.refresh() 让运行中的会话生效。
 */
export class SettingsService {
	constructor(private readonly getRuntime: () => Promise<ModelRuntime>) {}

	private get authPath(): string {
		return join(getAgentDir(), "auth.json");
	}

	private get modelsJsonPath(): string {
		return join(getAgentDir(), "models.json");
	}

	private async readCustomProviders(): Promise<JsonObject> {
		const data = await readJsonFile(this.modelsJsonPath);
		return (data.providers as JsonObject | undefined) ?? {};
	}

	private async refreshLocalModels(): Promise<void> {
		const runtime = await this.getRuntime();
		// Mutations are already durable; network catalog freshness must never block their IPC response.
		await runtime.refresh({ allowNetwork: false });
	}

	/** 从 models.json 原文提取 per-model 元数据（保留「未设置」状态，编辑表单预填用） */
	private customModelMeta(customEntry: JsonObject | undefined): Map<string, JsonObject> {
		const map = new Map<string, JsonObject>();
		const rawModels = customEntry?.models;
		if (!Array.isArray(rawModels)) return map;
		for (const raw of rawModels) {
			if (raw && typeof raw === "object" && typeof (raw as JsonObject).id === "string") {
				map.set((raw as JsonObject).id as string, raw as JsonObject);
			}
		}
		return map;
	}

	async listProviders(options?: ListProvidersOptions): Promise<ProviderInfo[]> {
		const runtime = await this.getRuntime();
		if (options?.forceNetwork) {
			// 用户显式刷新才联网；SDK 的目录请求无内置超时，这里兜底，超时抛错（UI 层回退到已加载的本地数据）
			const result = await runtime.refresh({
				allowNetwork: true,
				force: true,
				signal: AbortSignal.timeout(NETWORK_REFRESH_TIMEOUT_MS),
			});
			if (result.aborted) throw new Error("刷新模型目录超时，请检查网络后重试");
		} else {
			// 默认纯本地：内置目录 + models-store.json 缓存（refresh 的 allowNetwork 缺省为 true，必须显式关）
			await runtime.refresh({ allowNetwork: false });
		}
		const customs = await this.readCustomProviders();
		const customIds = new Set(Object.keys(customs));
		return runtime
			.getProviders()
			.map((provider) => {
				const status = runtime.getProviderAuthStatus(provider.id);
				const customEntry = customs[provider.id] as JsonObject | undefined;
				const modelMeta = this.customModelMeta(customEntry);
				return {
					id: provider.id,
					name: provider.name || provider.id,
					custom: customIds.has(provider.id),
					// 覆写 = models.json 条目存在、有 baseUrl 且 id 为内置（仅填 key 不算覆写）；全新 id = 真自定义
					overridesBuiltin:
						(customIds.has(provider.id) &&
							typeof customEntry?.baseUrl === "string" &&
							BUILTIN_PROVIDER_IDS.has(provider.id)) ||
						undefined,
					configured: status.configured,
					authSource: status.source,
					authLabel: status.label,
					// 订阅登录（OAuth）能力标记：UI 据此显示「订阅登录」入口（如 ChatGPT Plus/Pro、Claude Pro/Max）
					oauth: provider.auth.oauth
						? {
								loginLabel: provider.auth.oauth.loginLabel,
								isSubscription: provider.auth.oauth.isSubscription,
							}
						: undefined,
					// 自定义 provider 回填 baseUrl/api，编辑表单预填用（key 永不回读）
					...(customEntry
						? {
								baseUrl: typeof customEntry.baseUrl === "string" ? customEntry.baseUrl : undefined,
								api: typeof customEntry.api === "string" ? customEntry.api : undefined,
								// 已在 models.json 落盘的自定义模型定义：编辑表单预填用（区别于 runtime 全量 models）
								customModels: [...modelMeta.values()].map((raw) => ({
									id: String(raw.id),
									...(typeof raw.name === "string" ? { name: raw.name } : {}),
									...(raw.reasoning === true ? { reasoning: true } : {}),
									...(typeof raw.contextWindow === "number" ? { contextWindow: raw.contextWindow } : {}),
									...(typeof raw.maxTokens === "number" ? { maxTokens: raw.maxTokens } : {}),
									...(Array.isArray(raw.input) && raw.input.includes("image") ? { imageInput: true } : {}),
								})),
							}
						: {}),
					models: runtime.getModels(provider.id).map((model) => {
						const raw = modelMeta.get(model.id);
						return {
							id: model.id,
							name: model.name,
							...(raw
								? {
										reasoning: raw.reasoning === true || undefined,
										contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
										maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : undefined,
										imageInput: (Array.isArray(raw.input) && raw.input.includes("image")) || undefined,
									}
								: {}),
						};
					}),
				};
			})
			.sort((a, b) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));
	}

	/** 保存 API key 到 auth.json（chmod 0600），立即生效 */
	async saveApiKey(providerId: string, key: string): Promise<void> {
		const trimmed = key.trim();
		if (!trimmed) throw new Error("API key 不能为空");
		await jsonStoreFor(this.authPath, 0o600).update((auth) => {
			auth[providerId] = { type: "api_key", key: trimmed };
		});
		await this.refreshLocalModels();
	}

	/** 移除凭证：走 SDK logout（同步清理运行时内存态与 auth.json；直接删文件会让内存视图残留） */
	async removeCredential(providerId: string): Promise<void> {
		const runtime = await this.getRuntime();
		await runtime.logout(providerId);
		await this.refreshLocalModels();
	}

	/**
	 * 空模型列表的合法性：覆写内置 provider（ID 为内置）时可留空以共享其官方模型列表
	 * （SDK applyModelsJson 语义：无 models 时内置模型全保留、只覆写 baseUrl）；
	 * 全新 provider 空模型无意义（SDK 会加载出零模型 provider），直接拒绝。
	 * 注意必须用 BUILTIN_PROVIDER_IDS 判断而非 runtime.getProvider(id)——后者对 models.json
	 * 里已注册的自定义 provider 也返回真值，「编辑已有自定义 provider 时清空模型」会漏拦。
	 */
	private assertModelsMeaningful(id: string, models: readonly { id: string }[]): void {
		if (models.length > 0) return;
		if (!BUILTIN_PROVIDER_IDS.has(id)) {
			throw new Error(
				`${id} 不是内置 provider，留空模型列表无法使用；覆写内置 provider（如 openai）请用其 ID 并留空模型，即沿用官方模型列表`,
			);
		}
	}

	/** 校验并构建 models.json 条目（add/update 共用）；id 由调用方单独校验 */
	private buildCustomEntry(input: CustomProviderInput): JsonObject {
		if (!input.baseUrl.trim()) throw new Error("baseUrl 不能为空");
		if (!/^https?:\/\//i.test(input.baseUrl.trim())) {
			throw new Error("baseUrl 必须以 http(s):// 开头");
		}
		if (!input.api.trim()) throw new Error("api 协议不能为空");
		const models = input.models.filter((m) => m.id.trim());
		return {
			...(input.name?.trim() ? { name: input.name.trim() } : {}),
			baseUrl: input.baseUrl.trim(),
			api: input.api.trim(),
			// 模型留空不写 models 键：SDK 按「共享内置模型列表、仅覆写 baseUrl」处理（官方语义）
			...(models.length > 0
				? {
						models: models.map((m) => {
							for (const [field, value] of [
								["contextWindow", m.contextWindow],
								["maxTokens", m.maxTokens],
							] as const) {
								if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
									throw new Error(`模型 ${m.id.trim()} 的 ${field} 必须是正数`);
								}
							}
							// 缺省字段不写进 models.json，跟随 SDK 默认（reasoning:false / 128000 / 16384 / 仅文本）
							return {
								id: m.id.trim(),
								...(m.name?.trim() ? { name: m.name.trim() } : {}),
								...(m.reasoning ? { reasoning: true } : {}),
								...(m.contextWindow ? { contextWindow: Math.round(m.contextWindow) } : {}),
								...(m.maxTokens ? { maxTokens: Math.round(m.maxTokens) } : {}),
								...(m.imageInput ? { input: ["text", "image"] } : {}),
							};
						}),
					}
				: {}),
		};
	}

	/** 写 models.json 自定义 provider；可选把 key 存进 auth.json */
	async addCustomProvider(input: CustomProviderInput): Promise<void> {
		const id = input.id.trim();
		if (!id) throw new Error("Provider ID 不能为空");
		if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw new Error("Provider ID 只能包含字母、数字、-、_");

		this.assertModelsMeaningful(
			id,
			input.models.filter((m) => m.id.trim()),
		);

		await jsonStoreFor(this.modelsJsonPath).update((draft) => {
			const providers = (draft.providers as JsonObject | undefined) ?? {};
			providers[id] = this.buildCustomEntry(input);
			draft.providers = providers;
		});

		const apiKey = input.apiKey?.trim();
		if (apiKey) {
			await jsonStoreFor(this.authPath, 0o600).update((auth) => {
				auth[id] = { type: "api_key", key: apiKey };
			});
		}

		await this.refreshLocalModels();
	}

	/**
	 * 更新已存在的自定义 provider（name/baseUrl/api/models 全覆盖式更新）。
	 * ID 是主键（models.json/auth.json/会话模型引用都按它关联），不可修改。
	 * Key 语义：留空 = 保持不变；填写 = 替换（删除凭证走行上的「移除凭证」/「删除」）。
	 */
	async updateCustomProvider(input: CustomProviderUpdateInput): Promise<void> {
		const id = input.id.trim();
		if (!id) throw new Error("Provider ID 不能为空");

		this.assertModelsMeaningful(
			id,
			input.models.filter((m) => m.id.trim()),
		);
		await jsonStoreFor(this.modelsJsonPath).update((draft) => {
			const providers = (draft.providers as JsonObject | undefined) ?? {};
			if (!(id in providers)) throw new Error(`自定义 provider 不存在：${id}`);
			// 保留 pi TUI 手写的、表单不管理的字段（apiKey/headers/compat/modelOverrides 等）；
			// 表单管理字段（name/baseUrl/api/models）以表单为准。
			const preserved = { ...(providers[id] as JsonObject) };
			for (const field of MANAGED_PROVIDER_FIELDS) delete preserved[field];
			providers[id] = { ...preserved, ...this.buildCustomEntry(input) };
			draft.providers = providers;
		});

		const apiKey = input.apiKey?.trim();
		if (apiKey) {
			await jsonStoreFor(this.authPath, 0o600).update((auth) => {
				auth[id] = { type: "api_key", key: apiKey };
			});
		}

		await this.refreshLocalModels();
	}

	/**
	 * 内置 provider 的可选 baseUrl 覆写（pi 官方「Overriding Built-in Providers」语义：
	 * 不写 models，共享官方模型列表，仅替换端点）。只管理 providers[id].baseUrl 一个字段，
	 * 条目已有其他字段（pi 手写的 apiKey/headers 等）原样保留；baseUrl 空串 = 删除整条
	 * 回官方（含 pi 手写字段——语义即「回到官方」）。
	 * key 逻辑：apiKey 非空写 auth.json（删除凭证走行上的「移除凭证」）。
	 */
	async setProviderBaseUrl(providerId: string, baseUrl: string, apiKey?: string): Promise<void> {
		const id = providerId.trim();
		if (!id) throw new Error("Provider ID 不能为空");
		if (!BUILTIN_PROVIDER_IDS.has(id)) {
			throw new Error(`${id} 不是内置 provider，请改用「自定义 Provider」配置`);
		}
		const trimmedBase = baseUrl.trim();
		if (trimmedBase && !/^https?:\/\//i.test(trimmedBase)) {
			throw new Error("baseUrl 必须以 http(s):// 开头");
		}
		await jsonStoreFor(this.modelsJsonPath).update((draft) => {
			const providers = (draft.providers as JsonObject | undefined) ?? {};
			const entry = providers[id] as JsonObject | undefined;
			if (trimmedBase) {
				providers[id] = { ...entry, baseUrl: trimmedBase };
			} else if (entry) {
				delete providers[id];
			}
			draft.providers = providers;
		});

		const trimmedKey = apiKey?.trim();
		if (trimmedKey) {
			await jsonStoreFor(this.authPath, 0o600).update((auth) => {
				auth[id] = { type: "api_key", key: trimmedKey };
			});
		}

		await this.refreshLocalModels();
	}

	async removeCustomProvider(providerId: string): Promise<void> {
		const data = await readJsonFile(this.modelsJsonPath);
		const providers = (data.providers as JsonObject | undefined) ?? {};
		if (providerId in providers) {
			await jsonStoreFor(this.modelsJsonPath).update((draft) => {
				const p = (draft.providers as JsonObject | undefined) ?? {};
				delete p[providerId];
				draft.providers = p;
			});
		}
		const auth = await readJsonFile(this.authPath);
		if (providerId in auth) {
			await jsonStoreFor(this.authPath, 0o600).update((draft) => {
				delete draft[providerId];
			});
		}
		await this.refreshLocalModels();
	}

	/** 真实发一个最小请求验证凭证可用 */
	async testProvider(providerId: string, modelId?: string): Promise<ProviderTestResult> {
		const runtime = await this.getRuntime();
		const status = runtime.getProviderAuthStatus(providerId);
		if (!status.configured) {
			return { ok: false, error: "未配置凭证" };
		}
		const model = modelId
			? runtime.getModel(providerId, modelId)
			: (runtime.getModels(providerId)[0] ?? undefined);
		if (!model) {
			return { ok: false, error: "该 provider 下没有可用模型" };
		}
		try {
			await runtime.completeSimple(model, {
				messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
			});
			return { ok: true, modelId: model.id };
		} catch (error) {
			return { ok: false, modelId: model.id, error: error instanceof Error ? error.message : String(error) };
		}
	}
}
