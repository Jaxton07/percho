import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	DEFAULT_VISION_BASE_URL,
	DEFAULT_VISION_MODEL,
	type VisionConfig,
	type VisionConfigInfo,
	type VisionSaveInput,
} from "@percho/shared";

/** 默认关闭、无 key：必须显式开启 + 配置 key 才工作 */
const DEFAULT_CONFIG: VisionConfig = {
	enabled: false,
	apiKey: "",
	baseUrl: DEFAULT_VISION_BASE_URL,
	model: DEFAULT_VISION_MODEL,
};

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

	private async read(): Promise<VisionConfig> {
		if (this.cache) return this.cache;
		let config = { ...DEFAULT_CONFIG };
		try {
			const raw = await readFile(this.configPath, "utf8");
			const data = JSON.parse(raw) as Partial<VisionConfig>;
			config = {
				enabled: data.enabled === true,
				apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
				baseUrl: data.baseUrl?.trim() || DEFAULT_VISION_BASE_URL,
				model: data.model?.trim() || DEFAULT_VISION_MODEL,
			};
		} catch {
			// 无文件 / 损坏：用缺省
		}
		this.cache = config;
		return config;
	}

	private async write(config: VisionConfig): Promise<void> {
		this.cache = config;
		const dir = dirname(this.configPath);
		await mkdir(dir, { recursive: true });
		// 原子写：先写临时文件再 rename，避免写一半时读到残缺 JSON
		const tmp = join(dir, `.${Math.random().toString(36).slice(2)}.vision.tmp`);
		await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		await rename(tmp, this.configPath);
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
