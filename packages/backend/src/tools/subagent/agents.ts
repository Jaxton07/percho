import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type AgentSource = "builtin" | "user" | "project";

export interface SubagentDefinition {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	path?: string;
}

export interface DiscoverAgentsOptions {
	projectTrusted: boolean;
	agentDir?: string;
}

const BUILTIN_SCOUT: SubagentDefinition = {
	name: "scout",
	description: "快速代码侦察，读取并总结项目上下文，不修改文件。",
	tools: ["read", "grep", "find", "ls", "webfetch"],
	systemPrompt:
		"You are scout, a read-only reconnaissance agent. Inspect files and answer the assigned task concisely. Never modify files or run mutating commands.",
	source: "builtin",
};

function stripInlineComment(value: string): string {
	let quote: string | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if ((char === '"' || char === "'") && value[i - 1] !== "\\") {
			quote = quote === char ? undefined : (quote ?? char);
		}
		if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) return value.slice(0, i).trim();
	}
	return value.trim();
}

function parseScalar(value: string): string {
	const clean = stripInlineComment(value).trim();
	if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
		return clean.slice(1, -1).trim();
	}
	return clean;
}

function parseTools(value: string): string[] {
	const clean = stripInlineComment(value).trim();
	const inner = clean.startsWith("[") && clean.endsWith("]") ? clean.slice(1, -1) : clean;
	return inner
		.split(",")
		.map((item) => parseScalar(item))
		.filter(Boolean);
}

/** 解析官方/community subagent 约定的 markdown + YAML frontmatter。 */
export function parseAgentMarkdown(
	content: string,
	path?: string,
	source: AgentSource = "user",
): SubagentDefinition | null {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return null;

	const metadata = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (match) metadata.set(match[1] ?? "", match[2] ?? "");
	}
	const name = parseScalar(metadata.get("name") ?? "");
	if (!name) return null;
	const description = parseScalar(metadata.get("description") ?? "");
	const tools = parseTools(metadata.get("tools") ?? "read");
	const model = parseScalar(metadata.get("model") ?? "") || undefined;
	return {
		name,
		description,
		tools,
		model,
		systemPrompt: lines
			.slice(end + 1)
			.join("\n")
			.trim(),
		source,
		path,
	};
}

async function readAgentDirectory(dir: string, source: AgentSource): Promise<SubagentDefinition[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: SubagentDefinition[] = [];
	for (const entry of entries
		.filter((item) => item.isFile() && item.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(dir, entry.name);
		try {
			const agent = parseAgentMarkdown(await readFile(path, "utf8"), path, source);
			if (agent) agents.push(agent);
		} catch {
			// A malformed/unreadable optional agent must not prevent the built-in agent from loading.
		}
	}
	return agents;
}

/**
 * 发现 agent：builtin scout → user ~/.pi/agent/agents → trusted project .pi/agents。
 * 后加载的同名定义覆盖前者；projectTrusted=false 时完全不读取 project agents。
 */
export async function discoverAgents(
	cwd: string,
	options: DiscoverAgentsOptions,
): Promise<SubagentDefinition[]> {
	const byName = new Map<string, SubagentDefinition>([[BUILTIN_SCOUT.name, BUILTIN_SCOUT]]);
	const userAgents = await readAgentDirectory(join(options.agentDir ?? getAgentDir(), "agents"), "user");
	for (const agent of userAgents) byName.set(agent.name, agent);
	if (options.projectTrusted) {
		const projectAgents = await readAgentDirectory(join(cwd, ".pi", "agents"), "project");
		for (const agent of projectAgents) byName.set(agent.name, agent);
	}
	return [...byName.values()];
}

export function findAgent(agents: SubagentDefinition[], name: string): SubagentDefinition {
	const agent = agents.find((candidate) => candidate.name === name);
	if (!agent)
		throw new Error(
			`Unknown subagent agent "${name}". Available agents: ${agents.map((a) => a.name).join(", ")}`,
		);
	return agent;
}
