/** 设置页相关类型（IPC 往返用，独立于 pi 内部类型） */

/** pi-ai 的 KnownApi 协议可选值（自定义 provider 时用） */
export const KNOWN_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"azure-openai-responses",
	"mistral-conversations",
	"bedrock-converse-stream",
	"openai-codex-responses",
	"pi-messages",
] as const;

export type KnownApiId = (typeof KNOWN_APIS)[number];

export interface ListProvidersOptions {
	/** true 时强制从 pi.dev 联网拉取最新模型目录（绕过 4h 新鲜度窗口）；默认 false 只用内置目录 + 本地缓存 */
	forceNetwork?: boolean;
}

export interface ProviderModelInfo {
	id: string;
	name: string;
}

export interface ProviderInfo {
	id: string;
	/** 显示名 */
	name: string;
	/** 是否来自 models.json 的自定义 provider */
	custom: boolean;
	/** 是否有可用凭证 */
	configured: boolean;
	/** 凭证来源：stored / runtime / environment / models_json_key / models_json_command */
	authSource?: string;
	authLabel?: string;
	models: ProviderModelInfo[];
}

export interface CustomProviderModelInput {
	id: string;
	name?: string;
}

export interface CustomProviderInput {
	id: string;
	name?: string;
	baseUrl: string;
	/** KnownApiId 之一 */
	api: string;
	models: CustomProviderModelInput[];
	/** 可选；保存进 auth.json（0600），不写进 models.json */
	apiKey?: string;
}

export interface ProviderTestResult {
	ok: boolean;
	/** 失败原因（网络/鉴权等错误信息） */
	error?: string;
	/** 测试时实际使用的模型 */
	modelId?: string;
}
