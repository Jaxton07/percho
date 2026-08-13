import type { SlashCommandInfo } from "@percho/shared";

export const SOURCE_ORDER: SlashCommandInfo["source"][] = ["builtin", "template", "skill", "extension"];

const SKILL_PREFIX = "skill:";

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
