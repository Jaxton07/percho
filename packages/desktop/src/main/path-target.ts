import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 文件路径解析（「打开文件 / 在访达中显示 / 复制路径」三个动作共用）。
 *
 * 模型给出的路径什么形态都有：相对 / 绝对 / `~` / `file://` / 带 `:行:列` 或 `#L12-L20` 锚点 /
 * 中文与空格（可能被 percent-encode）/ 被反引号或括号包着。这里统一归一成磁盘上的绝对路径，
 * 解析全在主进程（renderer 不碰 fs，也拿不到 home 目录）。
 */

/** 成对包裹符：只剥「两端同款」的（避免吃掉路径里合法的括号，如 `My (notes)/a.md`） */
const WRAPPERS: readonly [string, string][] = [
	["`", "`"],
	['"', '"'],
	["'", "'"],
	["<", ">"],
	["(", ")"],
	["[", "]"],
];

/** 行号锚点：`:12` / `:12:5` / `#L12` / `#L12-L20` / `#L12C5`（只剥尾部，`C:\a\b.ts` 不受影响） */
const LINE_SUFFIXES = [/:\d+(?::\d+)?$/, /#L\d+(?:[-–]L?\d+)?(?:C\d+)?$/i];

/** percent-decoding（`%20`/中文编码）：非法转义（如文件名里的 `100%`）保持原样 */
function decodePercent(text: string): string {
	if (!text.includes("%")) return text;
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** file:// URL → 本地路径；非法 URL 退化成正则剥前缀 + 解码 */
function fromFileUrl(text: string): string {
	try {
		return fileURLToPath(text);
	} catch {
		return decodePercent(text.replace(/^file:\/\//i, ""));
	}
}

/** 清洗路径文本：去首尾空白与成对包裹符、剥行号锚点。返回裸路径（可能仍是相对/`~`/空串） */
export function cleanPathText(raw: string): string {
	let text = raw.trim();
	let changed = true;
	while (changed) {
		changed = false;
		for (const [open, close] of WRAPPERS) {
			if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
				text = text.slice(1, -1).trim();
				changed = true;
				break;
			}
		}
	}
	// 包裹符剥完再剥锚点：`(a.ts:12)` 先变 `a.ts:12` 再变 `a.ts`
	text = text.trim();
	for (const pattern of LINE_SUFFIXES) text = text.replace(pattern, "");
	return text.trim();
}

/** 解析成绝对路径（不检查存在性；空路径抛错）。相对路径以 cwd 为基准（缺省进程 cwd） */
export function resolvePathTarget(raw: string, cwd: string | null): string {
	const cleaned = cleanPathText(raw);
	if (!cleaned) throw new Error(`Empty path: ${JSON.stringify(raw)}`);
	let text = /^file:\/\//i.test(cleaned) ? fromFileUrl(cleaned) : decodePercent(cleaned);
	if (text === "~") text = homedir();
	else if (text.startsWith("~/")) text = join(homedir(), text.slice(2));
	const base = cwd && isAbsolute(cwd) ? cwd : process.cwd();
	return isAbsolute(text) ? normalize(text) : resolve(base, text);
}

/** 解析 + 存在性检查；不存在抛错（handler 把错误消息透到 toast detail） */
export function resolveExistingPath(raw: string, cwd: string | null): string {
	const resolved = resolvePathTarget(raw, cwd);
	if (!existsSync(resolved)) throw new Error(`Path not found: ${resolved}`);
	return resolved;
}
