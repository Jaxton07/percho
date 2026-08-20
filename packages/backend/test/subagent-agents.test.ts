import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents, parseAgentMarkdown } from "../src/tools/subagent/agents";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("subagent agent definitions", () => {
	it("parses frontmatter and body", () => {
		const agent = parseAgentMarkdown(
			`---\nname: scout\ndescription: Code scout\ntools: read, grep, find\nmodel: provider/model # optional\n---\n\nInspect files only.`,
		);
		expect(agent).toMatchObject({
			name: "scout",
			description: "Code scout",
			tools: ["read", "grep", "find"],
			model: "provider/model",
			systemPrompt: "Inspect files only.",
		});
	});

	it("applies builtin → user → trusted project precedence", async () => {
		const root = await mkdtemp("/tmp/percho-subagent-agents-");
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await mkdir(join(root, ".pi", "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "scout.md"),
			"---\nname: scout\ndescription: user\ntools: read\n---\nuser",
		);
		await writeFile(
			join(root, ".pi", "agents", "scout.md"),
			"---\nname: scout\ndescription: project\ntools: grep\n---\nproject",
		);

		const trusted = await discoverAgents(root, { agentDir, projectTrusted: true });
		expect(trusted.find((agent) => agent.name === "scout")).toMatchObject({
			description: "project",
			source: "project",
		});
		const untrusted = await discoverAgents(root, { agentDir, projectTrusted: false });
		expect(untrusted.find((agent) => agent.name === "scout")).toMatchObject({
			description: "user",
			source: "user",
		});
	});
});

describe("isSubagentSessionPath", () => {
	it("识别 sessions-subagents 目录下的会话文件（防 .. 绕判）", async () => {
		const { isSubagentSessionPath, subagentSessionsRoot } = await import("../src/tools/subagent");
		const root = "/tmp/percho-agent-dir";
		expect(isSubagentSessionPath(`${root}/sessions-subagents/proj/abc.jsonl`, root)).toBe(true);
		expect(isSubagentSessionPath(`${root}/sessions/proj/abc.jsonl`, root)).toBe(false);
		expect(isSubagentSessionPath(`${root}/sessions-subagents/../sessions/x.jsonl`, root)).toBe(false);
		expect(isSubagentSessionPath(`${root}/sessions-subagents-bogus/x.jsonl`, root)).toBe(false);
		expect(subagentSessionsRoot(root)).toBe(`${root}/sessions-subagents`);
	});
});
