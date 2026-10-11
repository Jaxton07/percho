/**
 * 保守 token 估算（spec D5）。
 *
 * **为什么不复用 `context-evaporation/estimate.ts`**：
 * - 用途不同：蒸发用估算**排序**（相对量，可乐观）；本模块用估算**判定上限**（绝对量，必须保守）。
 * - 系数不同（本模块更保守）：中文 0.55 / 其他 0.35，再乘安全系数 1.15，向上取整。
 *   实测口径（evidence/probe-tokenizer.mjs）：中文 ≈0.45/字、ASCII ≈0.30/字符 —— 这里在其之上留余量。
 * - 蒸发那份与 `scripts/replay-evaporation.mts` **逐字节同构**，动它会破坏既有验证口径（spec D5）。
 *
 * 零 SDK / 零仓库 import（纯函数，可单测、可离线重放共用）。
 */

/** 与蒸发同源的 CJK 判定（汉字 + 中文标点 + 全角） */
const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uff60]/;

export interface CharCounts {
	cjk: number;
	other: number;
}

export function countChars(text: string): CharCounts {
	let cjk = 0;
	let other = 0;
	for (const ch of text) {
		if (CJK_RE.test(ch)) cjk++;
		else other++;
	}
	return { cjk, other };
}

export function addCounts(a: CharCounts, b: CharCounts): CharCounts {
	return { cjk: a.cjk + b.cjk, other: a.other + b.other };
}

/** 纯 ASCII 文本（模板/系统提示）按「其他字符」系数计 */
export function asciiCounts(chars: number): CharCounts {
	return { cjk: 0, other: chars };
}

/** spec D5：`ceil((cjk × 0.55 + other × 0.35) × 1.15)` */
export function tokensFromCounts(counts: CharCounts): number {
	return Math.ceil((counts.cjk * 0.55 + counts.other * 0.35) * 1.15);
}

export function estimateTokens(text: string): number {
	return tokensFromCounts(countChars(text));
}
