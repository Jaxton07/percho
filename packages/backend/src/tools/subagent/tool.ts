import type {
	AgentSessionEvent,
	AgentToolResult,
	ExtensionContext,
	ModelRuntime,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { PermissionGate } from "../../permissions/gate";
import type { SessionTraces } from "../../session/traces";
import { discoverAgents, findAgent } from "./agents";
import { runSubagent, type SingleResult } from "./runner";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_CONTENT = 50_000;

const taskSchema = Type.Object({
	agent: Type.String({ minLength: 1, description: "Agent definition name, e.g. scout" }),
	task: Type.String({ minLength: 1, description: "Self-contained task for the subagent" }),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Optional working directory" })),
});

const subagentParams = Type.Union([
	Type.Intersect([taskSchema, Type.Object({ confirmProjectAgents: Type.Optional(Type.Boolean()) })]),
	Type.Object({
		tasks: Type.Array(taskSchema, { minItems: 1, maxItems: MAX_TASKS }),
		confirmProjectAgents: Type.Optional(Type.Boolean()),
	}),
]);

export interface MakeSubagentToolDeps {
	getModelRuntime: () => Promise<ModelRuntime>;
	getSubagentModel: (agentName: string) => Promise<string | undefined>;
	gate: PermissionGate;
	traces: SessionTraces;
	/** 把运行中子会话事件转发给桌面会话订阅方。 */
	onEvent?: (sessionId: string, event: AgentSessionEvent) => void;
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
	return result.exitCode !== 0 || result.error != null;
}

function contentForResults(results: SingleResult[], mode: SubagentDetails["mode"]): string {
	if (mode === "single") {
		const result = results[0];
		if (!result) return "";
		// 失败必须让模型看到诊断（spec §6：失败 = isError + 诊断）——空 content 会被当成「成功但无输出」
		if (isFailed(result)) return `Subagent ${result.agent} failed: ${result.error ?? "aborted"}`;
		return truncate(result.content ?? "");
	}
	return truncate(
		results
			.map((result, index) => {
				const header = `## ${index + 1}. ${result.agent}`;
				// 每任务独立截断，防单个超长输出挤掉其他任务（对齐官方 example 的 per-task cap）
				const body = result.error ? `Error: ${result.error}` : (result.content ?? "");
				return `${header}\n${truncate(body)}`;
			})
			.join("\n\n"),
	);
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
	return {
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a self-contained read-only or project-scoped task to an isolated subagent session. Use {agent, task} for one run or {tasks:[{agent, task}, ...]} for parallel exploration (up to 8 tasks, 4 at once). Built-in agent: scout. More agents may be defined in ~/.pi/agent/agents/. The subagent returns only its final conclusion while its full session remains available from the result card.",
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
			const mode: SubagentDetails["mode"] = "tasks" in params ? "parallel" : "single";
			const tasks = "tasks" in params ? params.tasks : [params];
			const shouldConfirm = params.confirmProjectAgents !== false;
			const projectTrusted = ctx.isProjectTrusted();
			const definitions = await Promise.all(
				tasks.map(async (task) => {
					const cwd = task.cwd ?? ctx.cwd;
					const agents = await discoverAgents(cwd, { projectTrusted });
					return { task, cwd, agents, agent: findAgent(agents, task.agent) };
				}),
			);
			await confirmProjectAgents(
				ctx,
				shouldConfirm,
				definitions.map(({ agent }) => agent),
			);

			// 固定槽位：结果按请求顺序归位（完成顺序不定），模型看到的结果顺序与请求一致
			const slots: Array<SingleResult | undefined> = new Array(definitions.length);
			const filled = () => slots.filter((slot): slot is SingleResult => slot !== undefined);
			const emit = () => onUpdate?.(partialResult(mode, filled()));
			await withConcurrency(definitions, MAX_CONCURRENCY, async ({ task, cwd, agent }, index) => {
				let result: SingleResult;
				try {
					result = await runSubagent(deps, {
						agent,
						task: task.task,
						cwd,
						projectTrusted,
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
			const results = filled();
			return finalizeSubagentResult(mode, results);
		},
	};
}
