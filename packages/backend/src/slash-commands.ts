import type { AgentSession, Extension, ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { SlashCommandInfo } from "@percho/shared";

/**
 * 斜杠命令清单（纯函数）：内置静态表 + prompt 模板 + skill + 扩展命令。
 * 会话态（listSlashCommands）与无会话态（listSlashCommandsForCwd）共用。
 */

/**
 * pi 内置斜杠命令表（桌面端只保留有实际用途的；TUI 专属/已有 UI 等价物的不列出）。
 * 注：模板/skill/扩展命令不由这里列出，SDK prompt() 原生处理。
 */
export const BUILTIN_SLASH_COMMANDS: SlashCommandInfo[] = [
	{
		name: "compact",
		description: "Compress session context",
		argumentHint: "[focus]",
		source: "builtin",
		supported: true,
	},
	{
		name: "name",
		description: "Set session display name",
		argumentHint: "<name>",
		source: "builtin",
		supported: true,
	},
	{
		name: "export",
		description: "Export session (.html/.jsonl)",
		argumentHint: "[path]",
		source: "builtin",
		supported: true,
	},
	{
		name: "settings",
		description: "Open settings",
		source: "builtin",
		supported: true,
	},
];

/** 模板命令映射（会话/无会话两态共用） */
function templateCommands(loader: ResourceLoader): SlashCommandInfo[] {
	return loader.getPrompts().prompts.map((template) => ({
		name: template.name,
		description: template.description,
		argumentHint: template.argumentHint,
		source: "template",
		supported: true,
	}));
}

/** skill 命令映射（会话/无会话两态共用） */
function skillCommands(loader: ResourceLoader): SlashCommandInfo[] {
	return loader.getSkills().skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill",
		supported: true,
	}));
}

/**
 * 无会话扩展命令清单（draft 用）：命令在扩展加载期就注册进 ext.commands
 * （注册类扩展 API 无需 bindExtensions），重名命令复刻 SDK
 * ExtensionRunner.resolveRegisteredCommands 的 :N 后缀去重规则。
 */
function extensionCommands(extensions: Extension[]): SlashCommandInfo[] {
	const all = extensions.flatMap((ext) => [...ext.commands.values()]);
	const counts = new Map<string, number>();
	for (const command of all) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
	const seen = new Map<string, number>();
	const taken = new Set<string>();
	return all.map((command) => {
		const occurrence = (seen.get(command.name) ?? 0) + 1;
		seen.set(command.name, occurrence);
		let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
		if (taken.has(invocationName)) {
			let suffix = occurrence;
			do {
				suffix++;
				invocationName = `${command.name}:${suffix}`;
			} while (taken.has(invocationName));
		}
		taken.add(invocationName);
		return {
			name: invocationName,
			description: command.description ?? "",
			source: "extension",
			supported: true,
		};
	});
}

/** 会话态清单：内置 + 模板 + skill + 扩展命令（runner 反映 bindExtensions 后的运行时注册与重名去重） */
export function slashCommandsForSession(session: AgentSession): SlashCommandInfo[] {
	const extensions: SlashCommandInfo[] = session.extensionRunner.getRegisteredCommands().map((command) => ({
		name: command.invocationName,
		description: command.description ?? "",
		source: "extension",
		supported: true,
	}));
	return [
		...BUILTIN_SLASH_COMMANDS,
		...templateCommands(session.resourceLoader),
		...skillCommands(session.resourceLoader),
		...extensions,
	];
}

/** 无会话态清单（draft 补全数据源）：只依赖 DefaultResourceLoader，扩展命令取加载期注册 */
export function slashCommandsForLoader(loader: ResourceLoader): SlashCommandInfo[] {
	return [
		...BUILTIN_SLASH_COMMANDS,
		...templateCommands(loader),
		...skillCommands(loader),
		...extensionCommands(loader.getExtensions().extensions),
	];
}
