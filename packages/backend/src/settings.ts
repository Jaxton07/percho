import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
	CustomProviderInput,
	ListProvidersOptions,
	ProviderInfo,
	ProviderTestResult,
} from "@percho/shared";

type JsonObject = Record<string, unknown>;

/** 联网刷新模型目录的整体超时（SDK fetchWithRetry 默认无超时，网络不可达时会一直挂） */
const NETWORK_REFRESH_TIMEOUT_MS = 15_000;

async function readJsonFile(path: string): Promise<JsonObject> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(stripJsonComments(raw)) as JsonObject;
	} catch {
		return {};
	}
}

/** models.json 支持 JSONC 注释；写入时统一输出纯 JSON */
function stripJsonComments(raw: string): string {
	return raw.replace(/\/\/[^\n"]*(?=\n)/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

async function writeJsonFile(path: string, data: JsonObject, mode?: number): Promise<void> {
	await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode });
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

	private async customProviderIds(): Promise<Set<string>> {
		const data = await readJsonFile(this.modelsJsonPath);
		const providers = data.providers as JsonObject | undefined;
		return new Set(providers ? Object.keys(providers) : []);
	}

	async listProviders(options?: ListProvidersOptions): Promise<ProviderInfo[]> {
		const runtime = await this.getRuntime();
		if (options?.forceNetwork) {
			// 用户显式刷新才联网；SDK 的目录请求无内置超时，这里兜底，超时回退本地数据
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
		const customIds = await this.customProviderIds();
		return runtime
			.getProviders()
			.map((provider) => {
				const status = runtime.getProviderAuthStatus(provider.id);
				return {
					id: provider.id,
					name: provider.name || provider.id,
					custom: customIds.has(provider.id),
					configured: status.configured,
					authSource: status.source,
					authLabel: status.label,
					models: runtime.getModels(provider.id).map((model) => ({ id: model.id, name: model.name })),
				};
			})
			.sort((a, b) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));
	}

	/** 保存 API key 到 auth.json（chmod 0600），立即生效 */
	async saveApiKey(providerId: string, key: string): Promise<void> {
		const trimmed = key.trim();
		if (!trimmed) throw new Error("API key 不能为空");
		const data = await readJsonFile(this.authPath);
		data[providerId] = { type: "api_key", key: trimmed };
		await writeJsonFile(this.authPath, data, 0o600);
		const runtime = await this.getRuntime();
		await runtime.refresh();
	}

	async removeCredential(providerId: string): Promise<void> {
		const data = await readJsonFile(this.authPath);
		if (providerId in data) {
			delete data[providerId];
			await writeJsonFile(this.authPath, data, 0o600);
		}
		const runtime = await this.getRuntime();
		await runtime.refresh();
	}

	/** 写 models.json 自定义 provider；可选把 key 存进 auth.json */
	async addCustomProvider(input: CustomProviderInput): Promise<void> {
		const id = input.id.trim();
		if (!id) throw new Error("Provider ID 不能为空");
		if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw new Error("Provider ID 只能包含字母、数字、-、_");
		if (!input.baseUrl.trim()) throw new Error("baseUrl 不能为空");
		if (!input.api.trim()) throw new Error("api 协议不能为空");
		const models = input.models.filter((m) => m.id.trim());
		if (models.length === 0) throw new Error("至少需要一个模型");

		const data = await readJsonFile(this.modelsJsonPath);
		const providers = (data.providers as JsonObject | undefined) ?? {};
		providers[id] = {
			...(input.name?.trim() ? { name: input.name.trim() } : {}),
			baseUrl: input.baseUrl.trim(),
			api: input.api.trim(),
			models: models.map((m) => ({
				id: m.id.trim(),
				...(m.name?.trim() ? { name: m.name.trim() } : {}),
			})),
		};
		data.providers = providers;
		await writeJsonFile(this.modelsJsonPath, data);

		if (input.apiKey?.trim()) {
			const auth = await readJsonFile(this.authPath);
			auth[id] = { type: "api_key", key: input.apiKey.trim() };
			await writeJsonFile(this.authPath, auth, 0o600);
		}

		const runtime = await this.getRuntime();
		await runtime.refresh();
	}

	async removeCustomProvider(providerId: string): Promise<void> {
		const data = await readJsonFile(this.modelsJsonPath);
		const providers = (data.providers as JsonObject | undefined) ?? {};
		if (providerId in providers) {
			delete providers[providerId];
			data.providers = providers;
			await writeJsonFile(this.modelsJsonPath, data);
		}
		const auth = await readJsonFile(this.authPath);
		if (providerId in auth) {
			delete auth[providerId];
			await writeJsonFile(this.authPath, auth, 0o600);
		}
		const runtime = await this.getRuntime();
		await runtime.refresh();
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
