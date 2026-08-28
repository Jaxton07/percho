/**
 * 统一错误信封 UiError（跨进程共用）：reducer（live 产卡）、mapping（历史回放产卡）、
 * Composer 内联条、全局 Toast 四个消费面共用同一结构。
 *
 * 设计约束（spec §7 安全清单）：
 * - detail 只做纯文本展示（绝不 dangerouslySetInnerHTML），构造时截断到 DETAIL_MAX_LENGTH；
 * - i18n 插值参数只放 provider/model/时间等安全值，禁止把 detail 塞进 titleParams。
 */

export type UiErrorSeverity = "error" | "warning" | "info";

/** 责任域（元信息行 + 未来 P2 面板的分类维度） */
export type UiErrorSource = "llm" | "session" | "tool" | "extension" | "app" | "network";

export type UiErrorAction = "retry" | "compact" | "openSettings" | "copyDetail";

export interface UiError {
	severity: UiErrorSeverity;
	source: UiErrorSource;
	/** i18n key（error.title.*）+ 插值参数（只放 provider/model 等安全值） */
	titleKey: string;
	titleParams?: Record<string, string | number>;
	/** 原始错误文本，折叠区展示；构造时截断到 DETAIL_MAX_LENGTH */
	detail?: string;
	/** 建议动作 i18n key（error.hint.*；无建议时缺省） */
	hintKey?: string;
	/** 操作行；有 detail 时恒含 copyDetail */
	actions: UiErrorAction[];
	timestamp: number;
}

/** detail 展示截断上限（防巨错误文本进渲染树） */
export const DETAIL_MAX_LENGTH = 4096;

/**
 * 用户主动中断（abort）的错误消息判定。
 * SDK 把「in-flight 模型请求被用户停止取消」归类为 stopReason="error"，errorMessage 是
 * AbortError 文案（DOMException："This operation was aborted"；SDK 上层："Request aborted"）。
 * 这类取消不是真实失败——reducer（live）与 mapping（历史回放）产 LLM 错误卡前必须排除，
 * 否则用户点停止会被渲染成「模型请求失败」+ 重试按钮（语义误导；实测两次中止分别出现
 * stopReason="error"/"This operation was aborted" 与 "aborted"/"Request aborted" 两种形态）。
 * 只匹配「被中止」句式（was aborted / request aborted），不匹配 provider 主动语态的
 * “provider aborted the request” 类真实错误；即便误判也只是不落卡，detail 不丢失。
 */
export function isUserAbortError(errorMessage: string): boolean {
	return /was aborted|request aborted/i.test(errorMessage);
}

/** computeLlmError 的归类结果（titleKey/hintKey/source/actions，与 UiError 差别在不含 detail/severity/timestamp） */
export interface LlmErrorClass {
	titleKey: string;
	hintKey?: string;
	source: UiErrorSource;
	actions: UiErrorAction[];
}

/** 截断 detail：超长时在末尾保留截断标记（多字节安全：按 code point 切） */
function truncateDetail(detail: string): string {
	if (detail.length <= DETAIL_MAX_LENGTH) return detail;
	return `${[...detail].slice(0, DETAIL_MAX_LENGTH).join("")}\n…[已截断]`;
}

/**
 * LLM 错误归类（spec §5.2 模式表）：按序首个命中，大小写不敏感。
 * 纯函数放 shared —— reducer（live）与 mapping（历史回放）共用同一份判定。
 * 注意：误判只影响标题/建议措辞，detail 原样可见（用户可自判），不做更激进的启发式。
 */
const LLM_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; cls: LlmErrorClass }> = [
	{
		// 凭证/auth 类
		pattern: /401|unauthorized|invalid\s+api\s+key|authentication/i,
		cls: {
			titleKey: "error.title.llmAuth",
			hintKey: "error.hint.checkApiKey",
			source: "llm",
			actions: ["retry", "openSettings", "copyDetail"],
		},
	},
	{
		// 频率受限（SDK 会自动重试，重试耗尽后仍 429 才走到这）
		pattern: /429|rate\s*limit|too\s+many\s*requests/i,
		cls: {
			titleKey: "error.title.llmRateLimit",
			hintKey: "error.hint.rateLimit",
			source: "llm",
			actions: ["retry", "copyDetail"],
		},
	},
	{
		// 上下文超限（SDK 走压缩，压缩失败/溢出才走到这）
		pattern: /context_length|context\s+length|maximum\s+context|too\s+many\s+tokens/i,
		cls: {
			titleKey: "error.title.llmOverflow",
			hintKey: "error.hint.compact",
			source: "llm",
			actions: ["compact", "copyDetail"],
		},
	},
	{
		// 网络/超时
		pattern: /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch\s+failed|\bnetwork\b|\btimeout\b/i,
		cls: {
			titleKey: "error.title.llmNetwork",
			hintKey: "error.hint.network",
			source: "network",
			actions: ["retry", "copyDetail"],
		},
	},
];

/** 兜底：无法归类的模型请求失败 */
const LLM_ERROR_FALLBACK: LlmErrorClass = {
	titleKey: "error.title.llmGeneric",
	source: "llm",
	actions: ["retry", "copyDetail"],
};

export function classifyLlmError(errorMessage: string): LlmErrorClass {
	for (const { pattern, cls } of LLM_ERROR_PATTERNS) {
		if (pattern.test(errorMessage)) return cls;
	}
	return LLM_ERROR_FALLBACK;
}

/**
 * 由 LLM 错误消息构造完整 UiError 信封（live 与历史回放共用）。
 * detail 截断到 DETAIL_MAX_LENGTH；动作表恒含 copyDetail（有 detail 时）。
 */
export function buildLlmUiError(errorMessage: string, now: number = Date.now()): UiError {
	const cls = classifyLlmError(errorMessage);
	return {
		severity: "error",
		source: cls.source,
		titleKey: cls.titleKey,
		detail: truncateDetail(errorMessage),
		...(cls.hintKey ? { hintKey: cls.hintKey } : {}),
		actions: cls.actions.includes("copyDetail") ? cls.actions : [...cls.actions, "copyDetail"],
		timestamp: now,
	};
}

/**
 * StreamGuard 熔断 → 合成 warning 条的固定信封（§5.3）：标题/建议固定，detail = verdict 原始串。
 */
export function buildStreamGuardUiError(verdict: string, now: number = Date.now()): UiError {
	return {
		severity: "warning",
		source: "app",
		titleKey: "error.title.streamGuard",
		hintKey: "error.hint.streamGuard",
		detail: truncateDetail(`StreamGuard tripped: ${verdict}`),
		actions: ["retry", "copyDetail"],
		timestamp: now,
	};
}
