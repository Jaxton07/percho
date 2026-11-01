import {
	type AgentSessionEvent,
	type AgentToolResult,
	defineTool,
	type ExtensionContext,
	type ModelRuntime,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "@percho/shared";
import { type Static, Type } from "typebox";
import type { PermissionGate } from "../../permissions/gate";
import type { SessionTraces } from "../../session/traces";
import { DEFAULT_AGENT, discoverAgents, findAgent } from "./agents";
import { runSubagent, type SingleResult, type SubagentRunHandle } from "./runner";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_CONTENT = 50_000;

const taskSchema = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1, description: "Custom agent name; defaults to worker" })),
	task: Type.String({ minLength: 1, description: "Self-contained task for the subagent" }),
});

/**
 * 拍平为单一 object schema（导出供测试断言）。不能用 Type.Union/Intersect：
 * - openai-completions 路径原样发送 schema，anyOf 顶层无 type:"object"，DeepSeek 直接 400；
 * - anthropic 路径的 convertTools 只保留顶层 properties/required，anyOf 会被剥成空 object，
 *   模型失去参数描述（kimi 断流/参数空洞的诱因）。
 * single / parallel 的互斥约束因此下沉到 execute 运行时校验。
 */
export const subagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ minLength: 1, description: "Custom agent name; defaults to worker (single run)" }),
	),
	task: Type.Optional(
		Type.String({ minLength: 1, description: "Self-contained task for the subagent (single run)" }),
	),
	tasks: Type.Optional(
		Type.Array(taskSchema, {
			minItems: 1,
			maxItems: MAX_TASKS,
			description: `Parallel runs (up to ${MAX_TASKS} tasks); mutually exclusive with agent/task`,
		}),
	),
	confirmProjectAgents: Type.Optional(Type.Boolean()),
});

export interface MakeSubagentToolDeps {
	getModelRuntime: () => Promise<ModelRuntime>;
	getSubagentModel: (agentName: string) => Promise<string | undefined>;
	/** 设置页的 per-agent 思考深度覆盖；无配置时返回 undefined 并继续走 frontmatter。 */
	getSubagentThinkingLevel: (agentName: string) => Promise<string | undefined>;
	getPermissionMode?: () => PermissionMode;
	gate: PermissionGate;
	traces: SessionTraces;
	/** 把运行中子会话事件转发给桌面会话订阅方。 */
	onEvent?: (sessionId: string, event: AgentSessionEvent, abort: () => Promise<void>) => void;
	registerRun?: (sessionId: string, handle: SubagentRunHandle) => void;
	unregisterRun?: (sessionId: string) => void;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
}

function truncate(text: string): string {
	return text.length <= MAX_CONTENT ? text : `${text.slice(0, MAX_CONTENT)}\n[truncated]`;
}

function partialResult(
	mode: SubagentDetails["mode"],
	results: SingleResult[],
): AgentToolResult<SubagentDetails> {
	return {
		content: [{ type: "text", text: "Subagent tasks are running..." }],
		details: { mode, results: results.map((result) => ({ ...result, usage: { ...result.usage } })) },
	};
}

async function withConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const consume = async () => {
		while (cursor < items.length) {
			const index = cursor++;
			const item = items[index];
			if (item === undefined) return;
			await worker(item, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
}

function isFailed(result: SingleResult): boolean {
	return result.status ? result.status !== "done" : result.exitCode !== 0 || result.error != null;
}

function contentForResults(results: SingleResult[], mode: SubagentDetails["mode"]): string {
	return results
		.map((result, index) => {
			const diagnostic =
				result.status === "aborted"
					? "Aborted by the user; not a task failure. 已由用户中止、不是任务失败。"
					: isFailed(result)
						? `Error: ${result.error ?? "subagent failed"}`
						: "";
			const summary = result.summary;
			const files = summary?.changedFiles ?? [];
			const facts = [
				`Changed ${files.length} files:`,
				...files.slice(0, 15).map((file) => `- ${file.path} (+${file.added}/-${file.removed})`),
				...(files.length > 15 ? [`... ${files.length - 15} more files`] : []),
				`Duration: ${summary?.durationMs ?? 0} ms; tokens: ${result.usage.totalTokens.tokens}`,
			].join("\n");
			return `${mode === "parallel" ? `## ${index + 1}. ${result.agent}\n` : ""}${diagnostic ? `${diagnostic}\n` : ""}${truncate(result.content ?? "")}\n\n${facts}`;
		})
		.join("\n\n");
}

/**
 * 收尾组装工具结果（纯函数，可单测）：single 任一失败 / parallel 全败 → isError。
 * parallel 部分失败不置 isError（各任务 Error 行已在 content 里，模型可自行消化）。
 */
export function finalizeSubagentResult(
	mode: SubagentDetails["mode"],
	results: SingleResult[],
): AgentToolResult<SubagentDetails> {
	const anyFailed = results.some(isFailed);
	const allFailed = results.length > 0 && results.every(isFailed);
	const isError = mode === "single" ? anyFailed : allFailed;
	return {
		content: [{ type: "text", text: contentForResults(results, mode) }],
		details: { mode, results },
		...(isError ? { isError: true } : {}),
	};
}

async function confirmProjectAgents(
	ctx: ExtensionContext,
	shouldConfirm: boolean,
	agents: Array<{ name: string; source: string }>,
): Promise<void> {
	const projectNames = [
		...new Set(agents.filter((agent) => agent.source === "project").map((agent) => agent.name)),
	];
	if (!shouldConfirm || projectNames.length === 0 || !ctx.hasUI) return;
	const allowed = await ctx.ui.confirm(
		"Allow project subagent definitions?",
		`This project provides subagent definitions: ${projectNames.join(", ")}. Their instructions will be executed in isolated sessions.`,
	);
	if (!allowed) throw new Error("Project subagent definitions were not approved");
}

/** 内置进程内 subagent 工具：single + bounded parallel，子会话深度固定为 1。 */
export function makeSubagentTool(deps: MakeSubagentToolDeps): ToolDefinition {
	// defineTool：官方 1.0.4 的类型收窄入口（execute 参数由 TParams 推导）
	return defineTool({
		name: "subagent",
		// 子会话会跑工具（可能改环境），权限由子会话扩展求值 → 这里如实声明为写且可破坏
		// （声明不参与本机弹窗判定：自研工具在权限门控里走「内置短路」，见 permissions/annotations.ts）
		annotations: { readOnlyHint: false, destructiveHint: true },
		label: "Subagent",
		description:
			"Delegate one self-contained task to an isolated subagent with its own context window. It can read\nand edit files, run commands and tests, and fetch docs. It cannot see this conversation, cannot\nspawn further subagents, cannot commit or push, and cannot change Percho's own configuration.\n\nUse it for work you can specify with a clear acceptance criterion: multi-file implementation or\nrefactor, fixing a failing suite, investigating an unfamiliar area. Do not delegate a single file\nread or a one-line answer — do that yourself.\n\nWrite the brief as if to a capable engineer who just joined: the goal, relevant paths, constraints,\nthe acceptance criteria, and what you already know. Anything you omit will be rediscovered at extra\ncost.\n\n{task, agent?} runs one task. {tasks:[...]} runs independent tasks in parallel (up to 8, 4 at a\ntime); the call returns after all of them finish. Omit `agent` to use the built-in subagent.\n\nReturns its final report plus machine-derived facts (files changed, duration, tokens). The full\ntranscript is not returned — the user can open it from the card. Runs are one-shot: to continue the\nwork, dispatch again with the new information.\n\nSpecify agent only for a custom definition. Bash is not path-restricted except for the git allowlist and text-level Percho state protection. Write scope is not enforced. Agent deny, the git allowlist, and read-only <agentDir> always apply, including fullAccess and permissions.json disabled; boundaries can only be tightened.",
		parameters: subagentParams,
		execute: async (
			toolCallId,
			rawParams,
			signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<SubagentDetails>> => {
			void toolCallId;
			const params = rawParams as Static<typeof subagentParams>;
			// 原 Union 的互斥约束运行时兜底：tasks 非空 → parallel，否则 agent+task 必填
			const parallelTasks = params.tasks?.length ? params.tasks : undefined;
			let tasks: Array<Static<typeof taskSchema>>;
			if (parallelTasks) {
				tasks = parallelTasks;
			} else {
				if (!params.task) {
					throw new Error('Missing "task": pass { task } for one run or { tasks: [...] } for parallel');
				}
				tasks = [{ agent: params.agent, task: params.task }];
			}
			const mode: SubagentDetails["mode"] = parallelTasks ? "parallel" : "single";
			const shouldConfirm = params.confirmProjectAgents !== false;
			const projectTrusted = ctx.isProjectTrusted();
			const agents = await discoverAgents(ctx.cwd, { projectTrusted });
			const definitions = tasks.map((task) => ({
				task,
				cwd: ctx.cwd,
				agent: findAgent(agents, task.agent ?? DEFAULT_AGENT),
			}));
			await confirmProjectAgents(
				ctx,
				shouldConfirm,
				definitions.map(({ agent }) => agent),
			);

			// 固定槽位：结果按请求顺序归位（完成顺序不定），模型看到的结果顺序与请求一致
			const slots: SingleResult[] = definitions.map(({ agent, task }, index) => ({
				agent: agent.name,
				task: task.task,
				status: "queued",
				exitCode: -1,
				index: definitions.length > 1 ? index + 1 : undefined,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: { tokens: 0 } },
				artifactPaths: {},
			}));
			const emit = () => onUpdate?.(partialResult(mode, slots));
			emit();
			await withConcurrency(definitions, MAX_CONCURRENCY, async ({ task, cwd, agent }, index) => {
				slots[index] = { ...slots[index]!, status: "running" };
				emit();
				const startedAt = Date.now();
				let result: SingleResult;
				try {
					result = await runSubagent(deps, {
						agent,
						task: task.task,
						cwd,
						projectTrusted,
						batchIndex: definitions.length > 1 ? index + 1 : undefined,
						model: ctx.model,
						signal,
						onProgress: (progress) => {
							slots[index] = progress;
							emit();
						},
					});
				} catch (error) {
					result = {
						agent: agent.name,
						task: task.task,
						exitCode: 1,
						status: signal?.aborted ? "aborted" : "failed",
						index: definitions.length > 1 ? index + 1 : undefined,
						summary: {
							changedFiles: [],
							commands: [],
							failedCommands: 0,
							durationMs: Date.now() - startedAt,
						},
						error: error instanceof Error ? error.message : String(error),
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							totalTokens: { tokens: 0 },
						},
						artifactPaths: {},
					};
				}
				slots[index] = result;
				emit();
			});
			return finalizeSubagentResult(mode, slots);
		},
	});
}
