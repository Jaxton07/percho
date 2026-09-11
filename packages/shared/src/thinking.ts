/** pi 支持的思考深度（顺序即显示顺序，也是档位高低顺序） */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 白名单校验（backend 解析 agent frontmatter / model-prefs 脏值过滤用）。
 * 只做「是否合法档位」判定，不做收敛——档位与模型能力的收敛全权交 SDK `clampThinkingLevel`。
 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
