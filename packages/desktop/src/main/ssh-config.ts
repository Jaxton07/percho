import { glob, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validateSshAlias } from "@percho/backend";
import type { SshAliasDiscovery } from "@percho/shared";

/** Discovery only: never evaluates Match/exec, starts ssh, or reads IdentityFile. */
export async function discoverSshAliases({
	home = homedir(),
	systemConfig = process.platform === "win32"
		? join(process.env.ProgramData ?? "C:\\ProgramData", "ssh", "ssh_config")
		: "/etc/ssh/ssh_config",
}: {
	home?: string;
	systemConfig?: string;
} = {}): Promise<SshAliasDiscovery> {
	const aliases = new Set<string>();
	const visited = new Set<string>();
	let bytes = 0;
	let incomplete = false;
	async function visit(file: string, base: string, depth: number): Promise<void> {
		if (depth > 8 || visited.size >= 64 || bytes >= 4 * 1024 * 1024) {
			incomplete = true;
			return;
		}
		try {
			const canonical = await realpath(file);
			const key = `${base}\0${canonical}`;
			if (visited.has(key)) return;
			visited.add(key);
			const info = await stat(canonical);
			if (!info.isFile() || info.size > 1024 * 1024 || bytes + info.size > 4 * 1024 * 1024) {
				incomplete = true;
				return;
			}
			const text = await readFile(canonical, "utf8");
			bytes += Buffer.byteLength(text);
			for (const line of text.split(/\r?\n/)) {
				const match = /^\s*(Host|Include)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
				if (!match) continue;
				const tokens = words(match[2] ?? "");
				if (!tokens) {
					incomplete = true;
					continue;
				}
				if (match[1]?.toLowerCase() === "host") {
					for (const token of tokens) {
						if (aliases.size >= 512) {
							incomplete = true;
							break;
						}
						try {
							aliases.add(validateSshAlias(token));
						} catch {
							/* Patterns are not concrete aliases. */
						}
					}
				} else {
					for (let pattern of tokens) {
						if (pattern.includes("%") || (pattern.startsWith("~") && !pattern.startsWith("~/"))) {
							incomplete = true;
							continue;
						}
						let missingVariable = false;
						pattern = pattern.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
							if (process.env[name] === undefined) {
								incomplete = true;
								missingVariable = true;
							}
							return process.env[name] ?? "";
						});
						if (!pattern || missingVariable) continue;
						if (pattern.startsWith("~/")) pattern = join(home, pattern.slice(2));
						if (!isAbsolute(pattern)) pattern = resolve(base, pattern);
						// OpenSSH's glob does not treat ** as recursive directory traversal.
						pattern = pattern.replace(/\*{2,}/g, "*");
						let count = 0;
						for await (const included of glob(pattern)) {
							if (++count > 64) {
								incomplete = true;
								break;
							}
							await visit(included, base, depth + 1);
						}
					}
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true;
		}
	}
	await visit(join(home, ".ssh", "config"), join(home, ".ssh"), 0);
	await visit(systemConfig, dirname(systemConfig), 0);
	return { aliases: [...aliases], incomplete };
}

/** Only the argument syntax needed by Host/Include; quoted whitespace and comments are preserved. */
function words(text: string): string[] | null {
	const tokens: string[] = [];
	let word = "",
		quote = "";
	for (let i = 0; i < text.length; i++) {
		const char = text[i] ?? "";
		const next = text[i + 1] ?? "";
		if (char === "\\" && next && /[\s\\'"#]/.test(next)) {
			word += next;
			i++;
		} else if (quote) {
			if (char === quote) quote = "";
			else word += char;
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "#") break;
		else if (/\s/.test(char)) {
			if (word) tokens.push(word);
			word = "";
		} else word += char;
	}
	if (quote) return null;
	if (word) tokens.push(word);
	return tokens;
}
