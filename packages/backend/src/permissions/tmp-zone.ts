import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * 系统临时区判定 + rm 目标提取（纯函数，供权限门控的地理分区豁免使用）。
 * 设计与边界语义表见 .local/docs/design/spec/permission-tmp-zone.md §5.2/§5.3。
 */

let cachedRoots: string[] | undefined;

/**
 * 临时区根集合（四拼写 → 两物理目录）：
 * resolve(tmpdir()) ∪ realpathSync(tmpdir()) ∪ "/tmp"（字面）∪ realpathSync("/tmp")（存在时）。
 * macOS 实测（2026-08 双重复核）：os.tmpdir() 字面 = /var/folders/<a>/<b>/T（$TMPDIR 形态，
 * agent/工具最常用）；realpath = /private/var/folders/...（/var 本身是 symlink，两拼写 inode 同址）。
 * 权限匹配文本经 path.resolve（纯词法、不解 symlink），只收 realpath 根会漏掉字面拼写 → 两拼写都收。
 * "/tmp" 同理收字面 + realpath 双根；Linux 四拼写坍缩为单根 /tmp；Windows 无 /tmp 时跳过。
 * 进程内计算一次并缓存。
 */
export function temporaryRoots(): string[] {
	if (cachedRoots) return cachedRoots;
	const roots = new Set<string>();
	const literal = resolve(tmpdir());
	roots.add(literal);
	try {
		roots.add(realpathSync(literal));
	} catch {
		// realpath 失败（目录异常消失等）保留字面根即可
	}
	roots.add("/tmp");
	try {
		roots.add(realpathSync("/tmp"));
	} catch {
		// 非 POSIX 平台无 /tmp
	}
	cachedRoots = [...roots];
	return cachedRoots;
}

/** abs 是否落在任一临时区根下（含根本身）。abs 必须是绝对路径；内部自行 resolve（穿越在此塌缩）。 */
export function isTemporaryPath(abs: string): boolean {
	const target = resolve(abs);
	return temporaryRoots().some((root) => {
		const rel = relative(root, target);
		return !rel.startsWith("..") && !isAbsolute(rel);
	});
}

/** 段首 token 是否为 rm（rm 家族判定；sudo rm / xargs rm / find -exec 的首 token 不是 rm → 不豁免）。 */
export function isRmSegment(segment: string): boolean {
	const first = segment.trim().split(/\s+/)[0] ?? "";
	return first === "rm";
}

interface SegmentToken {
	/** 剥引号后的字面文本 */
	text: string;
	/** 是否曾加引号（引号内 * / ? 是字面字符，不算 glob——bash 语义） */
	quoted: boolean;
}

/**
 * 引号感知 tokenize：引号外空白切分，剥配对引号并记录 quoted 标志。
 * 简化点（与 fail-safe 方向一致，宁可多弹不误放）：不处理反斜杠转义（\ 空格、\" 等）——
 * 含反斜杠的 token 按字面路径判定，resolve 后通常不在临时区 → 不豁免。
 */
function tokenizeSegment(segment: string): SegmentToken[] {
	const tokens: SegmentToken[] = [];
	let current = "";
	let quoted = false;
	let quote: string | null = null;
	const push = () => {
		if (current.length > 0 || quoted) {
			tokens.push({ text: current, quoted });
			current = "";
			quoted = false;
		}
	};
	for (const ch of segment) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			quoted = true;
			continue;
		}
		if (/\s/.test(ch)) {
			push();
			continue;
		}
		current += ch;
	}
	push();
	return tokens;
}

/** env 赋值前缀形态：VAR=val（shell 前缀赋值，rm 段内出现时跳过、不当路径） */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 未加引号的 glob 字符（* 或 ?） */
function isGlobToken(token: SegmentToken): boolean {
	return !token.quoted && /[*?]/.test(token.text);
}

/**
 * rm 段豁免判定：引号感知 tokenize → 跳过 flag / `--` 前的赋值前缀 → 剩余 token 全部视为
 * 路径参数 → 绝对路径直接判、相对路径按 cwd resolve → 存在路径参数且全部落在临时区才豁免。
 * 任一 token 判不中（变量、~、相对路径落界外、混合目标）→ false（fail-safe：宁可多弹，不可误放）。
 * glob token（未加引号且含 * / ?）取 dirname 判定；加引号的按字面路径判定。
 * cwd 缺省时相对路径无从证明 → 仅全绝对路径目标可判（fail-safe）。
 */
export function rmSegmentExempt(segment: string, cwd?: string): boolean {
	if (!isRmSegment(segment)) return false;
	const tokens = tokenizeSegment(segment);
	const paths: SegmentToken[] = [];
	let endOfFlags = false;
	for (const token of tokens.slice(1)) {
		if (!endOfFlags && !token.quoted && token.text === "--") {
			endOfFlags = true;
			continue;
		}
		// flag：- 开头的未引号 token（"-" 单独是 stdin 参数，按路径处理 → fail-safe）
		if (!endOfFlags && !token.quoted && token.text.startsWith("-") && token.text.length > 1) {
			continue;
		}
		// 赋值前缀仅在首个路径参数之前（VAR=val cmd 形态的前缀位置）跳过
		if (!endOfFlags && paths.length === 0 && !token.quoted && ASSIGNMENT_PREFIX.test(token.text)) {
			continue;
		}
		paths.push(token);
	}
	if (paths.length === 0) return false;
	if (cwd === undefined && paths.some((p) => !isAbsolute(p.text))) return false;
	return paths.every((token) => {
		const literal = isGlobToken(token) ? dirname(token.text) : token.text;
		return isAbsolute(literal)
			? isTemporaryPath(literal)
			: cwd !== undefined && isTemporaryPath(resolve(cwd, literal));
	});
}
