/**
 * bash 命令链解析（引号感知）：切段、命令替换提取、包装执行剥壳、求值候选收集。
 * 供权限规则求值（pattern.ts）与项目级记忆匹配共用；纯函数可独立单测。
 */

/**
 * bash 命令链切段：引号感知扫描，&& || & | ; 与换行仅在引号外分隔，去空段。
 * 引号内不执行分隔符（`echo "a && rm -rf x"` 不误切）；`2>&1` 的 `>&`/`<&` 不算分隔。
 */
export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaped = false;
	const push = () => {
		const trimmed = current.trim();
		if (trimmed.length > 0) segments.push(trimmed);
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			current += ch;
			quote = ch;
			continue;
		}
		if (ch === "&" || ch === "|") {
			const prev = current.trimEnd();
			// 重定向复制 fd（2>&1、<&0）不是命令分隔
			if (ch === "&" && (prev.endsWith(">") || prev.endsWith("<"))) {
				current += ch;
				continue;
			}
			if (command[i + 1] === ch) i++;
			push();
			continue;
		}
		if (ch === ";" || ch === "\n" || ch === "\r") {
			push();
			continue;
		}
		current += ch;
	}
	push();
	return segments;
}

/**
 * 提取顶层命令替换内容（$( ) 与反引号；单引号内不执行故跳过）。
 * 双引号内的替换仍执行，照常提取。嵌套由 collectBashCandidates 递归处理。
 */
export function extractSubstitutions(text: string): string[] {
	const found: string[] = [];
	let quote: string | null = null;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "'" && quote === null) {
			quote = "'";
			continue;
		}
		if (ch === '"') {
			quote = quote === '"' ? null : '"';
			continue;
		}
		if (ch === "`") {
			const end = text.indexOf("`", i + 1);
			if (end < 0) break;
			found.push(text.slice(i + 1, end));
			i = end;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			let depth = 1;
			let innerQuote: string | null = null;
			let innerEscaped = false;
			let j = i + 2;
			for (; j < text.length && depth > 0; j++) {
				const c = text[j];
				if (innerEscaped) {
					innerEscaped = false;
					continue;
				}
				if (c === "\\" && innerQuote !== "'") {
					innerEscaped = true;
					continue;
				}
				if (innerQuote) {
					if (c === innerQuote) innerQuote = null;
					continue;
				}
				if (c === "'" || c === '"') {
					innerQuote = c;
					continue;
				}
				if (c === "(") depth++;
				if (c === ")") depth--;
			}
			if (depth === 0) {
				found.push(text.slice(i + 2, j - 1));
				i = j - 1;
			} else {
				break;
			}
		}
	}
	return found;
}

const WRAPPER_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);

/** 去外层配对引号；有尾随内容时截取引号内部分（`'cmd' extra` → `cmd`） */
function extractQuoted(text: string): string {
	const q = text[0];
	if (q !== "'" && q !== '"') return text;
	const end = text.indexOf(q, 1);
	return end > 0 ? text.slice(1, end) : text.slice(1);
}

/**
 * 提取包装执行的真实命令：`sh|bash|... -c <cmd>`（含 -lc 等合并 flag）与 `eval <cmd>`。
 * 无法提取返回 null。xargs / find -exec / python -c 等其余包装不在覆盖范围（模式方案天花板）。
 */
export function extractShellExecArg(segment: string): string | null {
	const tokens = segment.trim().split(/\s+/);
	if (tokens[0] === "eval" && tokens.length > 1) {
		return extractQuoted(tokens.slice(1).join(" ").trim());
	}
	if (!WRAPPER_SHELLS.has(tokens[0] ?? "")) return null;
	let i = 1;
	while (i < tokens.length) {
		const flag = tokens[i];
		if (!flag || !/^-[a-zA-Z]+$/.test(flag)) break;
		if (flag.includes("c")) {
			const rest = tokens
				.slice(i + 1)
				.join(" ")
				.trim();
			return rest.length > 0 ? extractQuoted(rest) : null;
		}
		i++;
	}
	return null;
}

/**
 * 收集 bash 求值候选：整串（兼容 "curl * | sh*" 整串模式）+ 各段 +
 * 命令替换内容与 -c/eval 包装参数（递归，嵌套替换/包装逐层剥开）。
 */
export function collectBashCandidates(command: string): string[] {
	const candidates = new Set<string>();
	const visited = new Set<string>();
	const walk = (text: string) => {
		if (visited.has(text)) return;
		visited.add(text);
		candidates.add(text);
		for (const segment of splitShellSegments(text)) {
			candidates.add(segment);
			const execArg = extractShellExecArg(segment);
			if (execArg) {
				candidates.add(execArg);
				walk(execArg);
			}
		}
		for (const sub of extractSubstitutions(text)) {
			candidates.add(sub);
			walk(sub);
		}
	};
	walk(command);
	return [...candidates];
}
