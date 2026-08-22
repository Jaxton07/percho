import {
	DEFAULT_VISION_BASE_URL,
	DEFAULT_VISION_MODEL,
	type VisionConfig,
	type VisionConfigInfo,
	type VisionSaveInput,
} from "@percho/shared";
import { JsonStore } from "../json-store";

/** 识别失败占位缓存的重试窗口 */
export const VISION_RETRY_TTL_MS = 60_000;

/**
 * 视觉代理配置服务：userData/vision.json 读写 + 运行态语言。
 * 配置每次保存即写盘；扩展 handler 每次调用实时读取（getConfig），
 * 改配置对所有已打开会话立即生效，无需重载。
 */
export class VisionConfigService {
	private language: "zh" | "en" = "zh";
	private cache: VisionConfig | null = null;

	constructor(private readonly configPath: string) {}

	private store(): JsonStore<Partial<VisionConfig>> {
		return new JsonStore<Partial<VisionConfig>>({
			path: this.configPath,
			defaultValue: () => ({}),
		});
	}

	private async read(): Promise<VisionConfig> {
		if (this.cache) return this.cache;
		// 损坏/无文件回退缺省（JsonStore 保证）；字段级规整仍在服务层
		const data = await this.store().read();
		const config: VisionConfig = {
			enabled: data.enabled === true,
			apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
			baseUrl: data.baseUrl?.trim() || DEFAULT_VISION_BASE_URL,
			model: data.model?.trim() || DEFAULT_VISION_MODEL,
		};
		this.cache = config;
		return config;
	}

	private async write(config: VisionConfig): Promise<void> {
		this.cache = config;
		await this.store().write(config);
	}

	/** 运行态（含 key），仅供 backend 内部使用；绝不整个回传渲染层 */
	async getConfig(): Promise<VisionConfig> {
		return this.read();
	}

	/** 渲染层视图：key 只给存在性（$ENV 引用也算已配置） */
	async getInfo(): Promise<VisionConfigInfo> {
		const config = await this.read();
		return {
			enabled: config.enabled,
			hasKey: config.apiKey.trim().length > 0,
			baseUrl: config.baseUrl,
			model: config.model,
			language: this.language,
		};
	}

	async save(input: VisionSaveInput): Promise<VisionConfigInfo> {
		const current = await this.read();
		const next: VisionConfig = {
			enabled: input.enabled ?? current.enabled,
			apiKey: input.clearApiKey ? "" : input.apiKey?.trim() || current.apiKey,
			baseUrl:
				input.baseUrl !== undefined ? input.baseUrl.trim() || DEFAULT_VISION_BASE_URL : current.baseUrl,
			model: input.model !== undefined ? input.model.trim() || DEFAULT_VISION_MODEL : current.model,
		};
		await this.write(next);
		return this.getInfo();
	}

	setLanguage(language: "zh" | "en"): void {
		this.language = language;
	}

	getLanguage(): "zh" | "en" {
		return this.language;
	}
}

/** key 支持 $ENV_VAR 引用（与 models.json 凭证语义一致）；解析失败返回空串 */
export function resolveVisionKey(apiKey: string): string {
	const trimmed = apiKey.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("$")) {
		return process.env[trimmed.slice(1)]?.trim() ?? "";
	}
	return trimmed;
}
