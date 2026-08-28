import type { SlashCommandInfo } from "@percho/shared";

export const SOURCE_ORDER: SlashCommandInfo["source"][] = ["builtin", "template", "skill", "extension"];

const SKILL_PREFIX = "skill:";

/** 光标前的 / token：/ 必须在行首或空白后（空格+/ 触发；防 URL/路径误伤），query 不含空白 */
export interface SlashToken {
	/** / 在全文中的下标 */
	start: number;
	/** token 结束下标（= 检测时的光标位） */
	end: number;
	/** / 之后的查询词 */
	query: string;
}

/** 光标前 / token 探测（与 extractAtToken 同构）：任意位置可触发，不限于文本开头 */
export function extractSlashToken(text: string, cursor: number): SlashToken | null {
	const before = text.slice(0, cursor);
	const at = before.lastIndexOf("/");
	if (at === -1) return null;
	if (at > 0 && !/\s/.test(before[at - 1] ?? "")) return null;
	const query = before.slice(at + 1);
	if (/\s/.test(query)) return null;
	return { start: at, end: cursor, query };
}

/** 选中命令转胶囊后移除触发 token：两侧都空白时收掉一个；行首 token 不留前导空格（后续作为胶囊参数） */
export function removeSlashToken(text: string, token: SlashToken): string {
	const before = text.slice(0, token.start);
	let after = text.slice(token.end);
	if (after.startsWith(" ") && (before.endsWith(" ") || token.start === 0)) {
		after = after.slice(1);
	}
	return before + after;
}

/** 过滤后的命令列表（按来源分组顺序拍平；skill 子串命中排在最后）
 *  非 skill 命令维持前缀匹配；skill 命令额外支持去 skill: 前缀后的前缀/子串匹配 */
export function filterCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
	if (!query) return commands;
	const rest = commands.filter((c) => c.source !== "skill" && c.name.startsWith(query));
	const prefixSkills: SlashCommandInfo[] = [];
	const substringSkills: SlashCommandInfo[] = [];
	for (const skill of commands) {
		if (skill.source !== "skill") continue;
		const bare = skill.name.startsWith(SKILL_PREFIX) ? skill.name.slice(SKILL_PREFIX.length) : skill.name;
		if (skill.name.startsWith(query) || bare.startsWith(query)) {
			prefixSkills.push(skill);
		} else if (bare.includes(query)) {
			substringSkills.push(skill);
		}
	}
	return [...rest, ...prefixSkills, ...substringSkills];
}
