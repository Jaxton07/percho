/**
 * @ 文件补全的纯逻辑：token 解析 + fzf 式模糊评分（renderer 本地过滤，按键零 IPC）。
 * 数据源：backend `listProjectFiles`（相对路径，目录带尾 /）。
 */

/** 光标前的 @ token（@ 必须在行首或空白后，避免误伤邮箱；query 不含空白） */
export interface AtToken {
	/** @ 在全文中的下标 */
	start: number;
	/** token 结束下标（= 检测时的光标位） */
	end: number;
	/** @ 之后的查询词 */
	query: string;
}

export function extractAtToken(text: string, cursor: number): AtToken | null {
	const before = text.slice(0, cursor);
	const at = before.lastIndexOf("@");
	if (at === -1) return null;
	if (at > 0 && !/\s/.test(before[at - 1] ?? "")) return null;
	const query = before.slice(at + 1);
	if (/\s/.test(query)) return null;
	return { start: at, end: cursor, query };
}

/**
 * fzf 式子序列匹配评分：连续命中 / 词首（/ - _ . 后）/ 驼峰大写加分；
 * 未完整匹配返回 null；同分短路径靠前（length 罚分）。
 */
export function fuzzyScore(query: string, target: string): number | null {
	if (!query) return 0;
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let score = 0;
	let qi = 0;
	let lastMatch = -2;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] !== q[qi]) continue;
		score += 1;
		if (lastMatch === ti - 1) score += 3;
		const prev = ti === 0 ? "/" : (target[ti - 1] ?? "");
		if (prev === "/" || prev === "-" || prev === "_" || prev === ".") score += 4;
		if (target[ti] !== t[ti]) score += 2;
		lastMatch = ti;
		qi++;
	}
	if (qi < q.length) return null;
	return score - target.length * 0.01;
}

/** 过滤 + 排序 + 截断（空 query 取遍历序前 limit 条） */
export function filterFiles(files: string[], query: string, limit = 50): string[] {
	if (!query) return files.slice(0, limit);
	return files
		.map((f) => ({ f, s: fuzzyScore(query, f) }))
		.filter((x): x is { f: string; s: number } => x.s !== null)
		.sort((a, b) => b.s - a.s)
		.slice(0, limit)
		.map((x) => x.f);
}
