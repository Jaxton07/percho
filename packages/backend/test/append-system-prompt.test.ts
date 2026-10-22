import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type {
	AgentSessionEvent,
	CreateAgentSessionOptions,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionGate } from "../src/permissions/gate";
import { ProjectResourceLoader } from "../src/project/trust-loader";
import type { SessionTraces } from "../src/session/traces";
import { runSubagent } from "../src/tools/subagent/runner";

const { createAgentSessionMock } = vi.hoisted(() => ({ createAgentSessionMock: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		// 只隔离子代理的模型执行；两条路径都用真 SettingsManager/ResourceLoader/文件发现。
		createAgentSession: (...args: unknown[]) => createAgentSessionMock(...args),
	};
});

const DESKTOP = "DESKTOP_APPEND_MARKER";
const AGENT = "AGENT_APPEND_MARKER";
const PROJECT = "PROJECT_APPEND_MARKER";
const USER = "USER_APPEND_MARKER";
let root: string;
let cwd: string;
let agentDir: string;
let projectFile: string;
let userFile: string;

beforeEach(async () => {
	const sandbox = resolve("../../.local/tmp/append-system-tests");
	await mkdir(sandbox, { recursive: true });
	root = await mkdtemp(join(sandbox, "case-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	projectFile = join(cwd, ".pi", "APPEND_SYSTEM.md");
	userFile = join(agentDir, "APPEND_SYSTEM.md");
	await writeFile(projectFile, PROJECT);
	await writeFile(userFile, USER);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	createAgentSessionMock.mockReset();
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

async function mainLoader(
	options: {
		trusted?: boolean;
		injected?: string[];
		integration?: boolean;
		projectTrust?: boolean;
		additionalSkillPaths?: string[];
	} = {},
) {
	const trustStore = new ProjectTrustStore(agentDir);
	trustStore.set(cwd, options.trusted ?? true);
	const ask = vi.fn(async () => undefined);
	const loader = new ProjectResourceLoader({
		trustStore,
		ask,
		canAsk: () => false,
		buildExtensions: () => [],
		projectTrust: options.projectTrust,
		desktopIntegration:
			options.integration === false
				? undefined
				: {
						appendSystemPrompt: options.injected ?? [DESKTOP],
						additionalSkillPaths: options.additionalSkillPaths ?? [],
					},
	});
	const loaded = await loader.load(cwd);
	expect(ask).not.toHaveBeenCalled();
	return loaded;
}

/** 最小模型执行桩：捕获 runSubagent 实际交给 SDK 的 loader，不发送模型请求。 */
async function childLoader(trusted: boolean) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId: "append-system-child",
		sessionFile: undefined,
		messages: [],
		sessionManager: { getSessionDir: () => join(root, "child-session") },
		setSessionName: () => {},
		bindExtensions: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: async () => {
			for (const listener of listeners) listener({ type: "agent_settled", aborted: false });
		},
		dispose: vi.fn(),
	};
	createAgentSessionMock.mockResolvedValue({ session });
	const result = await runSubagent(
		{
			getModelRuntime: async () => ({}) as ModelRuntime,
			getSubagentModel: async () => undefined,
			getSubagentThinkingLevel: async () => undefined,
			gate: { confirm: async () => false } as unknown as PermissionGate,
			traces: {
				start: async () => {},
				stop: async () => {},
				record: () => {},
			} as unknown as SessionTraces,
		},
		{
			cwd,
			projectTrusted: trusted,
			task: "check append system prompt",
			agent: { name: "scout", description: "test", source: "user", tools: [], systemPrompt: AGENT },
		},
	);
	expect(result.exitCode).toBe(0);
	expect(session.dispose).toHaveBeenCalledOnce();
	const options = createAgentSessionMock.mock.calls[0]?.[0] as CreateAgentSessionOptions | undefined;
	if (!options?.resourceLoader) throw new Error("missing child resource loader");
	return { resourceLoader: options.resourceLoader, settingsManager: options.settingsManager };
}

it("both loaders feed file content and injected text into the real SDK system prompt", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
		"@earendil-works/pi-coding-agent",
	);
	const model = {
		id: "append-test",
		name: "append-test",
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<"openai-completions">;
	for (const [loaded, injected] of [
		[await mainLoader(), DESKTOP],
		[await childLoader(true), AGENT],
	] as const) {
		const { session } = await actual.createAgentSession({
			cwd,
			agentDir,
			model,
			noTools: "all",
			modelRuntime: { getModel: () => model } as unknown as ModelRuntime,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: loaded.settingsManager,
			resourceLoader: loaded.resourceLoader,
		});
		try {
			expect(session.systemPrompt).toContain(injected);
			expect(session.systemPrompt).toContain(PROJECT);
			expect(session.systemPrompt).not.toContain(USER);
			expect(session.systemPrompt.indexOf(injected)).toBeLessThan(session.systemPrompt.indexOf(PROJECT));
		} finally {
			session.dispose();
		}
	}
});

describe("main session APPEND_SYSTEM discovery with desktop integration", () => {
	it("keeps desktop text and trusted project file; project takes precedence over user", async () => {
		const { resourceLoader } = await mainLoader();
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([DESKTOP, PROJECT]);
		expect(resourceLoader.getAppendSystemPromptSources()).toEqual([{ path: projectFile }]);
	});

	it("does not load an untrusted project append; falls back to user file", async () => {
		const { resourceLoader, settingsManager } = await mainLoader({ trusted: false });
		expect(settingsManager.isProjectTrusted()).toBe(false);
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([DESKTOP, USER]);
		expect(resourceLoader.getAppendSystemPromptSources()).toEqual([{ path: userFile }]);
	});

	it("falls back to user file when trusted project has no append file", async () => {
		await rm(projectFile);
		const { resourceLoader } = await mainLoader();
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([DESKTOP, USER]);
	});

	it("keeps desktop text alone when no append file exists", async () => {
		await Promise.all([rm(projectFile), rm(userFile)]);
		const { resourceLoader } = await mainLoader();
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([DESKTOP]);
	});

	it.each([false, true])("preserves discovery with absent/empty integration: empty=%s", async (empty) => {
		const { resourceLoader } = await mainLoader({ integration: empty, injected: [] });
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([PROJECT]);
	});

	it("also merges in unattended projectTrust=false mode", async () => {
		const { resourceLoader, settingsManager } = await mainLoader({ trusted: false, projectTrust: false });
		expect(settingsManager.isProjectTrusted()).toBe(true);
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([DESKTOP, PROJECT]);
	});

	it("reload sees file edits and trust changes without duplicating desktop text", async () => {
		const { resourceLoader, settingsManager } = await mainLoader();
		await writeFile(projectFile, "PROJECT_UPDATED");
		await resourceLoader.reload();
		await resourceLoader.reload();
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([DESKTOP, "PROJECT_UPDATED"]);
		settingsManager.setProjectTrusted(false);
		await resourceLoader.reload();
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([DESKTOP, USER]);
		expect(resourceLoader.getAppendSystemPromptSources()).toEqual([{ path: userFile }]);
	});

	it("still passes additional desktop skill paths and keeps SYSTEM.md separate", async () => {
		const skill = join(root, "extra-skills", "append-test");
		await mkdir(skill, { recursive: true });
		await writeFile(
			join(skill, "SKILL.md"),
			"---\nname: append-test\ndescription: append test\n---\nTest instructions",
		);
		await writeFile(join(cwd, ".pi", "SYSTEM.md"), "PROJECT_SYSTEM_MARKER");
		const { resourceLoader } = await mainLoader({ additionalSkillPaths: [skill] });
		expect(resourceLoader.getSkills().skills.some((s) => s.name === "append-test")).toBe(true);
		expect(resourceLoader.getSystemPrompt()).toBe("PROJECT_SYSTEM_MARKER");
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([DESKTOP, PROJECT]);
	});
});

describe("subagent APPEND_SYSTEM discovery with agent instructions", () => {
	it.each([true, false])("respects parent trust=%s while keeping agent instructions", async (trusted) => {
		const { resourceLoader, settingsManager } = await childLoader(trusted);
		expect(settingsManager?.isProjectTrusted()).toBe(trusted);
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([AGENT, trusted ? PROJECT : USER]);
		expect(resourceLoader.getAppendSystemPromptSources()).toEqual([
			{ path: trusted ? projectFile : userFile },
		]);
	});

	it("falls back to user file when project file is missing", async () => {
		await rm(projectFile);
		const { resourceLoader } = await childLoader(true);
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([AGENT, USER]);
	});

	it("keeps agent instructions when neither file exists", async () => {
		await Promise.all([rm(projectFile), rm(userFile)]);
		const { resourceLoader } = await childLoader(true);
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([AGENT]);
	});

	it("reload updates file contents without repeating agent instructions or loading skills", async () => {
		const skill = join(cwd, ".pi", "skills", "project-skill");
		await mkdir(skill, { recursive: true });
		await writeFile(join(skill, "SKILL.md"), "---\nname: project-skill\ndescription: test\n---\nDo not load");
		const { resourceLoader } = await childLoader(true);
		await writeFile(projectFile, "PROJECT_UPDATED");
		await resourceLoader.reload();
		await resourceLoader.reload();
		expect(resourceLoader.getAppendSystemPrompt()).toEqual([AGENT, "PROJECT_UPDATED"]);
		expect(resourceLoader.getSkills().skills).toEqual([]);
	});
});
