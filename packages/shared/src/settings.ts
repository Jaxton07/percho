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

/** 用户级模型偏好（<agentDir>/model-prefs.json）。 */
export interface ModelPrefs {
	/** 隐藏的模型 id（provider → modelId 列表）；隐藏不影响已经选中的会话运行 */
	hiddenModels: Record<string, string[]>;
	subagentModels: Record<string, string>;
}

/** 设置页可配置的子代理（仅内置与用户级定义，不含项目级）。 */
export interface SubagentInfo {
	name: string;
	description: string;
	source: "builtin" | "user";
}

export interface ProviderModelInfo {
	id: string;
	name: string;
	/** 是否支持思考/推理（自定义 provider 从 models.json 原文回填，编辑预填用） */
	reasoning?: boolean;
	/** 上下文窗口 tokens（同上，未设置则为 undefined，SDK 缺省 128000） */
	contextWindow?: number;
	/** 最大输出 tokens（同上，SDK 缺省 16384） */
	maxTokens?: number;
	/** 支持图片输入（同上，SDK 缺省仅文本） */
	imageInput?: boolean;
}

/** provider 的订阅登录（OAuth）能力标记（来自 SDK `provider.auth.oauth`） */
export interface ProviderOAuthInfo {
	/** SDK 提供的登录选项文案（如 "Sign in with SuperGrok or X Premium"） */
	loginLabel?: string;
	/** 是否订阅制访问 */
	isSubscription?: boolean;
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
	/** 支持订阅登录（OAuth）时存在；UI 据此显示「订阅登录」入口 */
	oauth?: ProviderOAuthInfo;
	/** 自定义 provider 的 baseUrl（来自 models.json，编辑表单预填用；内置 provider 不填） */
	baseUrl?: string;
	/** 自定义 provider 的 api 协议（编辑表单预填用；内置 provider 不填） */
	api?: string;
	models: ProviderModelInfo[];
}

/** 订阅登录过程中的输入/选择提示（pi AuthPrompt 的 IPC 镜像；signal 不可跨进程，已剥离为 prompt-cancel 事件） */
export type LoginAuthPrompt =
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "manual_code"; message: string; placeholder?: string }
	| {
			type: "select";
			message: string;
			options: readonly { id: string; label: string; description?: string }[];
	  };

/** 订阅登录过程中的状态事件（pi AuthEvent 的 IPC 镜像） */
export type LoginAuthEvent =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/** main → renderer 登录事件载荷（按 loginId 归属一次登录流程；promptId 关联应答/取消） */
export type LoginEventPayload = { loginId: string } & (
	| { kind: "event"; event: LoginAuthEvent }
	| { kind: "prompt"; promptId: string; prompt: LoginAuthPrompt }
	| { kind: "prompt-cancel"; promptId: string }
);

/** 登录流程最终结果（settings:loginStart 的 invoke 返回值；取消不算错误） */
export interface LoginResult {
	ok: boolean;
	/** 用户主动取消（或 SDK 侧流程中止） */
	cancelled?: boolean;
	error?: string;
}

export interface CustomProviderModelInput {
	id: string;
	name?: string;
	/** 支持思考/推理；缺省 SDK 按 false 处理（思考深度会被钳到 off） */
	reasoning?: boolean;
	/** 上下文窗口 tokens；缺省 SDK 按 128000 */
	contextWindow?: number;
	/** 最大输出 tokens；缺省 SDK 按 16384 */
	maxTokens?: number;
	/** 支持图片输入；缺省仅文本 */
	imageInput?: boolean;
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

/** 更新自定义 provider：ID 为主键不可改；apiKey 留空 = 保持不变 */
export interface CustomProviderUpdateInput extends CustomProviderInput {
	/** true 时删除 auth.json 中已保存的 key（与 apiKey 互斥，优先生效） */
	clearApiKey?: boolean;
}

export interface ProviderTestResult {
	ok: boolean;
	/** 失败原因（网络/鉴权等错误信息） */
	error?: string;
	/** 测试时实际使用的模型 */
	modelId?: string;
}
