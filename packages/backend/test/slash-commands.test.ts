import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { slashCommandsForLoader, slashCommandsForSession } from "../src/slash-commands";

/**
 * 跨来源同名命令（#84，真实 SDK 加载 + 分发，无 LLM 调用）：
 * 模板 compact/review/plain、skill lint，扩展 compact/review/skill:lint，以及两个扩展都注册 deploy。
 */

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 记录哪个扩展的哪条命令真正被执行 */
const ran: string[] = [];

function commandExtension(name: string, commands: string[]) {
	return {
		name,
		factory: (pi: ExtensionAPI) => {
			for (const command of commands) {
				pi.registerCommand(command, {
					description: `${name} ${command}`,
					handler: async () => {
						ran.push(`${name}:${command}`);
					},
				});
			}
		},
	};
}

async function setup(
	extensions = [
		commandExtension("clash", ["compact", "review", "skill:lint"]),
		commandExtension("deploy-a", ["deploy"]),
		commandExtension("deploy-b", ["deploy"]),
	],
) {
	const root = await mkdtemp(join(tmpdir(), "percho-slash-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(join(agentDir, "prompts"), { recursive: true });
	await mkdir(join(agentDir, "skills", "lint"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	for (const name of ["compact", "review", "plain"]) {
		await writeFile(
			join(agentDir, "prompts", `${name}.md`),
			`---\ndescription: template ${name}\n---\nTemplate ${name}\n`,
		);
	}
	await writeFile(
		join(agentDir, "skills", "lint", "SKILL.md"),
		"---\nname: lint\ndescription: lint skill\n---\n# Lint\n",
	);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noThemes: true,
		extensionFactories: extensions,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.create(cwd, agentDir),
		resourceLoader: loader,
	});
	return { loader, session };
}

/** 只看本测试造的命令（用户机器上 ~/.agents/skills 之类的全局资源不参与断言） */
const FIXTURE_NAMES = ["compact", "review", "plain", "skill:lint", "deploy", "deploy:1", "deploy:2"];
const pick = (list: { name: string; source: string }[]) =>
	list.filter((c) => FIXTURE_NAMES.includes(c.name)).map((c) => `${c.source} /${c.name}`);

describe("斜杠命令跨来源同名", () => {
	it("新会话页清单：每个 /名字 只出现一次，归属执行时真正命中的来源，扩展之间仍是 :N", async () => {
		const { loader, session } = await setup();
		try {
			const commands = slashCommandsForLoader(loader);
			expect(pick(commands).sort()).toEqual(
				[
					"builtin /compact",
					"template /plain",
					"extension /review",
					"extension /skill:lint",
					"extension /deploy:1",
					"extension /deploy:2",
				].sort(),
			);
			const names = commands.map((c) => c.name);
			expect(new Set(names).size).toBe(names.length);
			// 内置命令表本身不受影响
			expect(commands.filter((c) => c.source === "builtin").map((c) => c.name)).toEqual([
				"compact",
				"name",
				"export",
				"settings",
			]);
		} finally {
			session.dispose();
		}
	});

	it("会话态清单与新会话页一致", async () => {
		const { loader, session } = await setup();
		try {
			expect(slashCommandsForSession(session)).toEqual(slashCommandsForLoader(loader));
		} finally {
			session.dispose();
		}
	});

	it("列出的每一条都执行到它标注的来源", async () => {
		const { session } = await setup();
		try {
			// 内置命令由渲染端 runSlashCommand 先拦截，不进 SDK；其余条目交给 SDK prompt()，
			// 它先按名字查扩展命令——只有标成扩展的条目才应命中扩展，否则模板/skill 条目实际跑的是扩展
			for (const command of slashCommandsForSession(session)) {
				if (command.source === "builtin") continue;
				const handledByExtension = session.extensionRunner.getCommand(command.name) !== undefined;
				expect({ name: command.name, handledByExtension }).toEqual({
					name: command.name,
					handledByExtension: command.source === "extension",
				});
			}
			ran.length = 0;
			for (const name of ["review", "skill:lint", "deploy:1", "deploy:2"]) {
				await session.prompt(`/${name}`);
			}
			expect(ran).toEqual(["clash:review", "clash:skill:lint", "deploy-a:deploy", "deploy-b:deploy"]);
		} finally {
			session.dispose();
		}
	});

	it("两个扩展都注册 compact：内置 /compact 不变，扩展照常以 :N 列出并执行到各自那条", async () => {
		const { session } = await setup([
			commandExtension("compact-a", ["compact"]),
			commandExtension("compact-b", ["compact"]),
		]);
		try {
			const compacts = slashCommandsForSession(session)
				.filter((c) => c.name.startsWith("compact"))
				.map((c) => `${c.source} /${c.name}`);
			expect(compacts).toEqual(["builtin /compact", "extension /compact:1", "extension /compact:2"]);
			ran.length = 0;
			await session.prompt("/compact:1");
			await session.prompt("/compact:2");
			expect(ran).toEqual(["compact-a:compact", "compact-b:compact"]);
		} finally {
			session.dispose();
		}
	});
});
