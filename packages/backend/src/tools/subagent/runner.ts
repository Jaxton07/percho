import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { makePermissionGateExtension } from "../../permissions/extension";
import type { PermissionGate, PermissionRequestMeta } from "../../permissions/gate";
import type { SessionTraces } from "../../session/traces";
import { makeUiContext } from "../../session/ui-context";
import { makeWebFetchTool } from "../webfetch";
import type { SubagentDefinition } from "./agents";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: { tokens: number };
}

export interface SingleResult {
	agent: string;
	task: string;
	model?: string;
	exitCode: number;
	error?: string;
	content?: string;
	usage: SubagentUsage;
	artifactPaths: { jsonlPath?: string };
}

export interface RunSubagentInput {
	agent: SubagentDefinition;
	task: string;
	cwd: string;
	/** 父会话的项目信任态（子会话 SettingsManager 对齐，不硬编码 trusted） */
	projectTrusted: boolean;
	model?: Model<any>;
	signal?: AbortSignal;
	onProgress?: (result: SingleResult) => void;
}

export interface RunSubagentDeps {
	getModelRuntime: () => Promise<ModelRuntime>;
	/** 设置页的 per-agent 覆盖；无配置时返回 undefined 并继续走 frontmatter / 父模型。 */
	getSubagentModel: (agentName: string) => Promise<string | undefined>;
	gate: PermissionGate;
	traces: SessionTraces;
}

const EMPTY_USAGE: SubagentUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	totalTokens: { tokens: 0 },
};

/** 子会话统一根目录（与主历史列表物理隔离；openSession 据此判定只读） */
export function subagentSessionsRoot(agentDir: string = getAgentDir()): string {
	return join(agentDir, "sessions-subagents");
}

/** filePath 是否落在子会话目录下（规范化后做前缀判定，防 `..` 绕判） */
export function isSubagentSessionPath(filePath: string, agentDir?: string): boolean {
	const root = resolve(subagentSessionsRoot(agentDir));
	const normalized = resolve(filePath);
	return normalized === root || normalized.startsWith(root + sep);
}

function projectSlug(cwd: string): string {
	const slug = cwd.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "default";
}

export async function resolveModel(
	runtime: ModelRuntime,
	spec: string | undefined,
	fallback: Model<any> | undefined,
): Promise<Model<any> | undefined> {
	if (!spec) return fallback;
	const slash = spec.indexOf("/");
	if (slash > 0) return runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) ?? fallback;
	const matches = (await runtime.getAvailable()).filter((model) => model.id === spec);
	return matches.length === 1 ? matches[0] : fallback;
}

/** 模型优先级：设置页 per-agent 覆盖 > agent frontmatter > 父会话模型。 */
export async function resolveSubagentModel(
	runtime: ModelRuntime,
	preference: string | undefined,
	frontmatter: string | undefined,
	fallback: Model<any> | undefined,
): Promise<Model<any> | undefined> {
	return resolveModel(runtime, preference ?? frontmatter, fallback);
}

/** 子会话标题对齐主会话命名：任务首行，最多 30 字；加 agent 前缀方便快速检视。 */
export function subagentSessionName(agent: string, task: string): string {
	const firstLine = (task.trim().split("\n")[0] ?? "").trim();
	const title = firstLine.length > 30 ? `${firstLine.slice(0, 30)}…` : firstLine;
	return title ? `${agent}: ${title}` : agent;
}

function assistantText(session: { messages: readonly unknown[] }): string {
	const messages = [...session.messages].reverse();
	const assistant = messages.find((message) => (message as { role?: string }).role === "assistant") as
		| { content?: unknown[] }
		| undefined;
	if (!assistant || !Array.isArray(assistant.content)) return "";
	return assistant.content
		.filter((block): block is { type: "text"; text: string } => {
			const item = block as { type?: string; text?: unknown };
			return item.type === "text" && typeof item.text === "string";
		})
		.map((block) => block.text)
		.join("")
		.trim();
}

type UsageDelta = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	totalTokens?: number;
};

function usageFromMessage(message: unknown): UsageDelta {
	const usage = (message as { usage?: Record<string, unknown> } | undefined)?.usage;
	if (!usage) return {};
	const cost = usage.cost as { total?: unknown } | undefined;
	return {
		input: typeof usage.input === "number" ? usage.input : undefined,
		output: typeof usage.output === "number" ? usage.output : undefined,
		cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
		cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
		cost: typeof cost?.total === "number" ? cost.total : undefined,
		totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
	};
}

function addUsage(target: SubagentUsage, delta: UsageDelta): void {
	target.input += delta.input ?? 0;
	target.output += delta.output ?? 0;
	target.cacheRead += delta.cacheRead ?? 0;
	target.cacheWrite += delta.cacheWrite ?? 0;
	target.cost += delta.cost ?? 0;
	// totalTokens 是单条消息的累计上下文量（非增量）：取峰值而非求和，求和会重复计数
	if (typeof delta.totalTokens === "number") {
		target.totalTokens.tokens = Math.max(target.totalTokens.tokens, delta.totalTokens);
	}
}

function modelLabel(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

/** 在共享 ModelRuntime 上运行一个隔离的、深度固定为 1 的子会话。 */
export async function runSubagent(deps: RunSubagentDeps, input: RunSubagentInput): Promise<SingleResult> {
	const runtime = await deps.getModelRuntime();
	const model = await resolveSubagentModel(
		runtime,
		await deps.getSubagentModel(input.agent.name),
		input.agent.model,
		input.model,
	);
	const agentDir = getAgentDir();
	const sessionDir = join(subagentSessionsRoot(agentDir), projectSlug(input.cwd));
	const childGateConfirm = (title: string, message: string, meta?: PermissionRequestMeta) =>
		deps.gate.confirm(`[${input.agent.name}] ${title}`, message, meta);
	const childSettings = SettingsManager.create(input.cwd, agentDir, {
		projectTrusted: input.projectTrusted,
	});
	const safeTools = input.agent.tools.filter((name) => name !== "subagent" && !name.startsWith("subagent_"));
	const customTools = safeTools.includes("webfetch") ? [makeWebFetchTool()] : [];
	const resourceLoader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir,
		settingsManager: childSettings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		appendSystemPrompt: [input.agent.systemPrompt],
		extensionFactories: [
			makePermissionGateExtension(agentDir, {
				projectRoot: input.cwd,
				confirm: childGateConfirm,
			}),
		],
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.create(input.cwd, sessionDir);
	const { session } = await createAgentSession({
		cwd: input.cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		tools: safeTools,
		customTools,
		sessionManager,
		settingsManager: childSettings,
		resourceLoader,
	});
	// 子会话没有主会话的 message_start 自动命名器；创建后立即把任务首行写进自己的 jsonl。
	session.setSessionName(subagentSessionName(input.agent.name, input.task));
	await session.bindExtensions({ uiContext: makeUiContext(deps.gate), mode: "tui" });
	const result: SingleResult = {
		agent: input.agent.name,
		task: input.task,
		model: modelLabel(session.model),
		exitCode: -1,
		usage: structuredClone(EMPTY_USAGE),
		artifactPaths: { jsonlPath: session.sessionFile },
	};
	input.onProgress?.(result);

	let settled = false;
	let failure: string | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	// 等待 agent_settled 而非 agent_end：_runAgentPrompt 的 finally 保证 settled 在全部路径
	// （正常结束 / 异常逃逸 / abort）都触发；agent_end 在 overflow 重试（willRetry）或异常时不算终结。
	const endPromise = new Promise<void>((resolve) => {
		unsubscribeEvents = session.subscribe((event: AgentSessionEvent) => {
			void deps.traces.record(session.sessionId, event);
			if (event.type === "message_end") addUsage(result.usage, usageFromMessage(event.message));
			if (event.type === "agent_settled") {
				settled = true;
				resolve();
			}
		});
	});
	const abort = () => {
		void session.abort();
	};
	if (input.signal) {
		if (input.signal.aborted) abort();
		else input.signal.addEventListener("abort", abort, { once: true });
	}
	try {
		await deps.traces.start(session.sessionId, session.sessionManager.getSessionDir());
		// expandPromptTemplates: false——子会话无任何模板/命令，任务文本以 "/" 开头也不触发命令解析
		await session.prompt(input.task, { expandPromptTemplates: false });
		if (!settled) await endPromise;
		result.content = assistantText(session);
		result.exitCode = input.signal?.aborted ? 1 : 0;
		// 子会话 LLM 错误不一定 throw（stopReason "error" 体现在最后一条 assistant 消息上）
		const lastAssistant = [...session.messages]
			.reverse()
			.find((message) => (message as { role?: string }).role === "assistant") as
			| { stopReason?: string; errorMessage?: string }
			| undefined;
		if (lastAssistant?.stopReason === "error") {
			result.exitCode = 1;
			result.error = lastAssistant.errorMessage ?? "subagent model error";
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		result.exitCode = 1;
		result.error = failure;
	} finally {
		unsubscribeEvents?.();
		input.signal?.removeEventListener("abort", abort);
		await deps.traces.stop(session.sessionId);
		session.dispose();
	}
	if (failure && !result.error) result.error = failure;
	// totalTokens 从未上报时回落 input+output（卡片 tokens 展示用）
	if (result.usage.totalTokens.tokens === 0) {
		result.usage.totalTokens.tokens = result.usage.input + result.usage.output;
	}
	// 子会话在任何消息落盘前失败时 sessionFile 不存在——不给卡片一个打不开的点击目标
	if (result.artifactPaths.jsonlPath && !existsSync(result.artifactPaths.jsonlPath)) {
		result.artifactPaths = {};
	}
	return result;
}
