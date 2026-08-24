/**
 * unified patch 解析（纯函数）：SDK edit 工具 details.patch（jsdiff createTwoFilesPatch，
 * 标准 unified 格式：---/+++ 文件头 + @@ hunk，4 行上下文）→ 结构化 hunks，供 diff 侧栏
 * 双 gutter 行号渲染。容错优先：任何异常格式返回 []，绝不抛（UI 只统计不渲染 diff 体）。
 */

export interface PatchLine {
	kind: "ctx" | "add" | "del";
	/** 旧文件行号（add 行无） */
	oldNo: number | null;
	/** 新文件行号（del 行无） */
	newNo: number | null;
	/** 行内容（不含 +/-/空格 前缀） */
	text: string;
}

export interface PatchHunk {
	oldStart: number;
	newStart: number;
	/** 原始 hunk 头行（@@ -a,b +c,d @@ 含可选 section 标题） */
	header: string;
	lines: PatchLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): PatchHunk[] {
	if (typeof patch !== "string" || patch.length === 0) return [];
	const raw = patch.split("\n");
	// 末尾换行产生的空串不是任何行（unified 的 ctx 行恒带前导空格）
	if (raw[raw.length - 1] === "") raw.pop();
	const hunks: PatchHunk[] = [];
	let current: PatchHunk | null = null;
	let oldNo = 0;
	let newNo = 0;
	for (const line of raw) {
		if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		const m = HUNK_RE.exec(line);
		if (m) {
			oldNo = Number(m[1]);
			newNo = Number(m[2]);
			current = { oldStart: oldNo, newStart: newNo, header: line, lines: [] };
			hunks.push(current);
			continue;
		}
		// hunk 头之前的垃圾行 / "\ No newline at end of file" 标记：忽略
		if (!current || line.startsWith("\\")) continue;
		const tag = line[0];
		if (tag === "+") {
			current.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
		} else if (tag === "-") {
			current.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
		} else {
			// ctx：标准带前导空格；无前缀的异常行按 ctx 容错（不丢行号递进）
			current.lines.push({
				kind: "ctx",
				oldNo: oldNo++,
				newNo: newNo++,
				text: tag === " " ? line.slice(1) : line,
			});
		}
	}
	return hunks;
}

/** +/− 行计数（排除 ---/+++ 文件头）。解析失败/无变更返回 {0,0}。 */
export function patchStat(patch: string): { added: number; removed: number } {
	if (typeof patch !== "string" || patch.length === 0) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+")) {
			if (!line.startsWith("+++")) added++;
		} else if (line.startsWith("-")) {
			if (!line.startsWith("---")) removed++;
		}
	}
	return { added, removed };
}
