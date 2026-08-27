import { buildLlmUiError, classifyLlmError, DETAIL_MAX_LENGTH, type UiError } from "@percho/shared";

/**
 * 发送路径失败 → UiError（Composer 内联条 data 源）。
 * 发送拒绝（无模型/无 key/会话只读/会话不存在/压缩中）与 LLM 运行错误不同源：
 * - 只读会话 → 专有标题（发送动作根本不该发生）；
 * - 其余复用 classifyLlmError 的模式表（auth/网络等的 hint 建议措辞正好适用），
 *   未命中（纯本地拒绝）则兜底「发送失败」，detail 保留原始 message 原文。
 * 纯函数放这里（随 Composer 域），+ 测试 send-error.test.ts。
 */
export function buildSendUiError(message: string, now: number = Date.now()): UiError {
	const lower = message.toLowerCase();
	if (lower.includes("read-only")) {
		return {
			severity: "error",
			source: "session",
			titleKey: "error.title.sendReadOnly",
			detail: truncateDetail(message),
			actions: ["copyDetail"],
			timestamp: now,
		};
	}
	const cls = classifyLlmError(message);
	const base = buildLlmUiError(message, now);
	return {
		...base,
		titleKey: cls.titleKey === "error.title.llmGeneric" ? "error.title.sendFailed" : cls.titleKey,
	};
}

function truncateDetail(detail: string): string {
	if (detail.length <= DETAIL_MAX_LENGTH) return detail;
	return `${[...detail].slice(0, DETAIL_MAX_LENGTH).join("")}\n…[已截断]`;
}
