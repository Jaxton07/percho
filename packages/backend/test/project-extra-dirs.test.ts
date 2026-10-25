import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemMessage,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extraDirsPrompt, makeProjectExtraDirsExtension } from "../src/tools/project-extra-dirs/extension";

/**
 * 项目额外目录（spec：只做上下文声明，不进资源发现、不改 cwd）。
 *
 * 两层断言：纯函数看措辞/清洗；接线走**真实 SDK**（内置扩展写 `systemPromptOptions.sections`），
 * 只读公开的 `session.systemPrompt`——不碰 private 字段。
 */

describe("extraDirsPrompt（措辞是行为契约）", () => {
	it("空数组不注入（undefined，而不是空串）", () => {
		expect(extraDirsPrompt([])).toBeUndefined();
	});

	it("单目录：一句说明 + 一行绝对路径", () => {
		expect(extraDirsPrompt(["/abs/one"])).toBe(
			"项目还有这些目录（不在 cwd 内，需要时用绝对路径访问）：\n- /abs/one",
		);
	});

	it("多目录：保序，且每个目录单独一行", () => {
		const text = extraDirsPrompt(["/abs/a", "/abs/b/c"]) ?? "";
		expect(text.split("\n")).toEqual([
			"项目还有这些目录（不在 cwd 内，需要时用绝对路径访问）：",
			"- /abs/a",
			"- /abs/b/c",
		]);
	});
});

const model = {
	id: "extra-dirs-test",
	name: "extra-dirs-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as never;

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
	const sandbox = resolve("../../.local/tmp/project-extra-dirs-tests");
	await mkdir(sandbox, { recursive: true });
	root = await mkdtemp(join(sandbox, "case-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** 走桌面端同一条路：内置扩展注册进 loader → createAgentSession → 发一轮（模型层打桩）→ 拿真实请求里的 systemPrompt */
async function promptWith(dirs: () => string[], sessionManager?: SessionManager, betweenTurns?: () => void) {
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [makeProjectExtraDirsExtension({ cwd, getDirs: dirs })],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		resourceLoader,
		noTools: "all",
		sessionManager: sessionManager ?? SessionManager.create(cwd, join(root, "sessions")),
		modelRuntime: { getModel: () => model, hasConfiguredAuth: () => true } as never,
	});
	const prompts: string[] = [];
	session.agent.streamFunction = async (_model, context) => {
		// 请求真正发给模型的系统提示词：system 消息（含 sections）由 pi 渲染成文本
		const systemMessage = getCurrentSystemMessage(context.messages as never);
		prompts.push(systemMessage ? getSystemMessageText(systemMessage) : (context.systemPrompt ?? ""));
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	};
	try {
		await session.prompt("fixture");
		const sessionFile = session.sessionFile;
		// 第二轮：同一会话再发一次，验证 before_agent_start 每轮现取（不是只在建会话时算一次）
		betweenTurns?.();
		await session.prompt("fixture 2");
		return { prompt: prompts[0] ?? "", prompts, sessionFile };
	} finally {
		session.dispose();
	}
}

describe("内置扩展接线（真实 SDK 的请求投影）", () => {
	it("额外目录写成独立 section，且在 cwd 之后", async () => {
		const { prompt } = await promptWith(() => ["/abs/extra"]);
		expect(prompt).toContain("<project_extra_dirs>");
		expect(prompt).toContain("- /abs/extra");
		expect(prompt.indexOf("- /abs/extra")).toBeGreaterThan(prompt.indexOf("<cwd>"));
	});

	it("脏值在扩展内再洗一遍：重复/空白/等于 cwd 的条目都不进段落", async () => {
		const { prompt } = await promptWith(() => ["/abs/extra", "/abs/extra", " ", "", cwd]);
		expect(prompt.match(/- \/abs\/extra/g)).toHaveLength(1);
		expect(prompt).not.toContain(`- ${cwd}`);
	});

	it("空列表不产生段落（不误伤没有额外目录的项目）", async () => {
		const { prompt } = await promptWith(() => []);
		expect(prompt).not.toContain("<project_extra_dirs>");
	});

	it("恢复同一 session 文件时按当前配置重建段落；同一会话下一轮也现取", async () => {
		const dirs = ["/abs/old"];
		const first = await promptWith(() => dirs);
		expect(first.prompt).toContain("- /abs/old");
		expect(first.sessionFile).toBeTruthy();
		if (!first.sessionFile) throw new Error("missing session file");

		const resumed = await promptWith(() => ["/abs/new"], SessionManager.open(first.sessionFile));
		expect(resumed.prompt).toContain("<project_extra_dirs>");
		expect(resumed.prompt).toContain("- /abs/new");
	});

	it("同一会话的下一轮就现取新配置（改了设置不必重开会话）", async () => {
		let dirs = ["/abs/before"];
		const { prompts } = await promptWith(
			() => dirs,
			undefined,
			() => {
				dirs = ["/abs/after"];
			},
		);
		expect(prompts[0]).toContain("- /abs/before");
		expect(prompts[1]).toContain("- /abs/after");
		expect(prompts[1]).not.toContain("- /abs/before");
	});

	it("同一会话里把列表清空，下一轮段落就消失（不会留着上一轮的旧值）", async () => {
		let dirs = ["/abs/gone"];
		const { prompts } = await promptWith(
			() => dirs,
			undefined,
			() => {
				dirs = [];
			},
		);
		expect(prompts[0]).toContain("- /abs/gone");
		expect(prompts[1]).not.toContain("<project_extra_dirs>");
	});

	it("扩展名固定为 project-extra-dirs（设置页「扩展」里按这个名字显示）", () => {
		expect(makeProjectExtraDirsExtension({ cwd: "/tmp/x", getDirs: () => [] }).name).toBe(
			"project-extra-dirs",
		);
	});
});
