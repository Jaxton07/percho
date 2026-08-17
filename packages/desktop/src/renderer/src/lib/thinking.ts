/** pi 支持的思考深度（顺序即显示顺序，也是档位高低顺序） */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 将当前档位收敛到模型支持的档位集合：
 *   1. 若 supported 已包含 level，直接返回；
 *   2. 否则在 THINKING_LEVELS 顺序里找第一个 >= level 的（就近向上）；
 *   3. 都没有（所有 supported 都比 level 小）则取 supported 中最高档；
 *   4. supported 为空时返回原 level（调用方应保证 supported 非空）；
 *   5. level 不在 THINKING_LEVELS 中（脏数据）时按步骤 3 取 supported 最高档。
 *
 * 注意：与 SDK clampThinkingLevel 的「反向就近降级」策略不同；这里是「就近向上 +
 * supported 末位回退」。supported 应保证按 THINKING_LEVELS 顺序传入（当前由后端
 * getSupportedThinkingLevels 通过 THINKING_LEVELS 过滤保证）。
 */
export function clampThinkingLevel(level: string, supported: readonly string[]): string {
	if (supported.length === 0) return level;
	if (supported.includes(level)) return level;
	const order = THINKING_LEVELS as readonly string[];
	const currentIdx = order.indexOf(level);
	if (currentIdx === -1) {
		return supported.at(-1) as string;
	}
	for (let i = currentIdx + 1; i < order.length; i++) {
		const candidate = order[i];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	return supported.at(-1) as string;
}
