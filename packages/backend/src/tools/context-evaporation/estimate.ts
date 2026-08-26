/**
 * token 估算器（纯函数，零 SDK/零仓库 import）。
 *
 * CJK×1.7 + 非 CJK/4，逐字符区段判断——移植自 scripts/replay-evaporation.mts:65-85
 * （replay 实测误差 2.6%，见 .local/agent-work/handoff/evap-replay-results.md §7.4）。
 * 无 API 场景的排序/水位兜底口径；触发判断优先用 getContextUsage() 的真实 usage。
 */

/** 图片 token 估算常量（与 replay 一致；SDK 内部按 4800 字符≈1200，差异不影响排序） */
export const IMAGE_FULL_TOKENS = 1000;
export const IMAGE_STUB_TOKENS = 25;

/** CJK 区段判断（含谚文/假名注音/全角等，粗粒度够用） */
export function isCJKCode(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x11ff) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xa960 && cp <= 0xa97f) ||
		(cp >= 0xac00 && cp <= 0xd7ff) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xfffd)
	);
}

/** 中文 ≈ 1.7 token/字，其余 ≈ 1 token/4 字符 */
export function estTokens(s: string): number {
	if (!s) return 0;
	let cjk = 0;
	for (let i = 0; i < s.length; i++) {
		if (isCJKCode(s.charCodeAt(i))) cjk++;
	}
	return Math.ceil(cjk * 1.7 + (s.length - cjk) / 4);
}
