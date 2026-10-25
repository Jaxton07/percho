import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extraDirsPrompt, ProjectResourceLoader } from "../src/project/trust-loader";

/**
 * 项目额外目录（spec：只做上下文声明，不进资源发现、不改 cwd）。
 *
 * 两层断言：纯函数看措辞/排序；接线看**真实 SDK 的 `session.systemPrompt`**（公开 API）——
 * 不读 `DefaultResourceLoader.appendSystemPrompt` 那类 private 字段，SDK 内部结构调整时测试不会假红。
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

const STATIC = "DESKTOP_STATIC_MARKER";
const HEADER = "项目还有这些目录（不在 cwd 内，需要时用绝对路径访问）：";

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
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

/** 走桌面端同一条路：ProjectResourceLoader（含静态段落）→ createAgentSession → 读公开的 systemPrompt */
async function systemPromptFor(projectExtraDirs?: (cwd: string) => string[]) {
	const { createAgentSession, SessionManager, SettingsManager } = await vi.importActual<
		typeof import("@earendil-works/pi-coding-agent")
	>("@earendil-works/pi-coding-agent");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const loader = new ProjectResourceLoader({
		trustStore: new ProjectTrustStore(agentDir),
		ask: async () => undefined,
		canAsk: () => false,
		buildExtensions: () => [],
		// projectTrust=false = 无人值守路径：不做信任弹窗直接加载（只为跑通构造，与桌面端接线无关）
		projectTrust: false,
		desktopIntegration: { appendSystemPrompt: [STATIC], additionalSkillPaths: [] },
		projectExtraDirs,
	});
	const { resourceLoader } = await loader.load(cwd);
	const created = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		resourceLoader,
		noTools: "all",
		sessionManager: SessionManager.create(cwd, join(root, "sessions")),
		modelRuntime: { getModel: () => model, hasConfiguredAuth: () => true } as never,
	});
	const session = created.session;
	try {
		return { prompt: session.systemPrompt, sessionFile: session.sessionFile };
	} finally {
		session.dispose();
	}
}

describe("接线（真实 SDK 的系统提示词）", () => {
	it("额外目录段落出现，且在桌面端静态段落之后", async () => {
		const { prompt } = await systemPromptFor(() => ["/abs/extra"]);
		expect(prompt).toContain(`- /abs/extra`);
		const staticAt = prompt.indexOf(STATIC);
		const extraAt = prompt.indexOf(HEADER);
		expect(staticAt).toBeGreaterThanOrEqual(0);
		expect(extraAt).toBeGreaterThan(staticAt);
	});

	it("按 cwd 取目录：回调收到会话 cwd；空列表不产生段落", async () => {
		const seen: string[] = [];
		const { prompt } = await systemPromptFor((dir) => {
			seen.push(dir);
			return [];
		});
		expect(seen).toEqual([cwd]);
		expect(prompt).not.toContain(HEADER);
	});

	it("未配置回调时不注入（纯 CLI 默认行为不变）", async () => {
		const { prompt } = await systemPromptFor(undefined);
		expect(prompt).toContain(STATIC);
		expect(prompt).not.toContain(HEADER);
	});

	it("新建与恢复（同一 session 文件）两个路径都注入，且不把 cwd 当额外目录列出", async () => {
		const { createAgentSession, SessionManager, SettingsManager } = await vi.importActual<
			typeof import("@earendil-works/pi-coding-agent")
		>("@earendil-works/pi-coding-agent");
		const extra = ["/abs/extra-a", "/abs/extra-b"];
		const first = await systemPromptFor(() => extra);
		for (const dir of extra) expect(first.prompt).toContain(`- ${dir}`);
		// 系统提示词里 `<cwd>` 段本就有 cwd；这里只断言额外目录列表没把它再列一遍（清洗规则）
		expect(first.prompt).not.toContain(`- ${cwd}`);
		expect(first.sessionFile).toBeTruthy();
		if (!first.sessionFile) throw new Error("missing session file");

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		});
		const loader = new ProjectResourceLoader({
			trustStore: new ProjectTrustStore(agentDir),
			ask: async () => undefined,
			canAsk: () => false,
			buildExtensions: () => [],
			projectTrust: false,
			projectExtraDirs: () => extra,
		});
		const { resourceLoader } = await loader.load(cwd);
		const resumed = await createAgentSession({
			agentDir,
			model,
			settingsManager,
			resourceLoader,
			noTools: "all",
			sessionManager: SessionManager.open(first.sessionFile),
			modelRuntime: { getModel: () => model, hasConfiguredAuth: () => true } as never,
		});
		try {
			for (const dir of extra) expect(resumed.session.systemPrompt).toContain(`- ${dir}`);
		} finally {
			resumed.session.dispose();
		}
	});
});
