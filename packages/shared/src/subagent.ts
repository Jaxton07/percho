/**
 * 子代理运行数据提取（跨进程共用）：从 subagent 工具结果的 details 结构检测运行组。
 * 从 session.ts 拆出（session.ts 回归纯类型 + 消息 union 定义）。
 */
/** 子代理运行结果（扩展 subagent 工具 details 提取，独立消息展示用） */
export interface SubagentRunData {
	/** 子代理名（如 reviewer / scout） */
	agent: string;
	task?: string;
	status: "done" | "error";
	model?: string;
	/** 子代理消耗的 token 数 */
	tokens?: number;
	/** 非 0 表示子代理执行出错 */
	exitCode?: number;
	/** 产物目录 */
	artifactsDir?: string;
	/** 子代理会话文件路径（点击可打开完整对话） */
	sessionFile?: string;
}

/**
 * 从工具结果 details 提取子代理运行数据。
 * 结构检测（不依赖工具名）：details.results 数组且至少一项带 agent/sessionFile → 返回运行组，否则 null。
 * 兼容 pi-subagents 及遵循同约定的社区扩展：
 * - 同步/foreground：details.results[]（agent/task/exitCode/usage/model/artifactPaths.jsonlPath）
 * - 后台并行：subagent_wait 的 details.completions[].results[]（agent/success/artifactPaths.outputPath 可能是子会话 jsonl）
 */
export function extractSubagentRuns(details: unknown): SubagentRunData[] | null {
	const d = details as
		| {
				results?: unknown[];
				completions?: unknown[];
				artifacts?: { dir?: unknown };
		  }
		| null
		| undefined;
	if (!d) return null;
	const runs: SubagentRunData[] = [];
	const artifactsDir = typeof d.artifacts?.dir === "string" ? d.artifacts.dir : undefined;

	const pushRun = (
		agent: unknown,
		rest: {
			task?: unknown;
			model?: unknown;
			exitCode?: unknown;
			error?: unknown;
			sessionFile?: unknown;
			tokens?: unknown;
		},
	) => {
		if (typeof agent !== "string") return;
		const sessionFile = typeof rest.sessionFile === "string" ? rest.sessionFile : undefined;
		const task = typeof rest.task === "string" && rest.task.length > 0 ? rest.task : undefined;
		const exitCode = typeof rest.exitCode === "number" ? rest.exitCode : undefined;
		const error = typeof rest.error === "string" && rest.error.length > 0 ? rest.error : undefined;
		runs.push({
			agent,
			task,
			status: exitCode != null && exitCode !== 0 ? "error" : error ? "error" : "done",
			model: typeof rest.model === "string" ? rest.model : undefined,
			tokens: typeof rest.tokens === "number" ? rest.tokens : undefined,
			exitCode,
			artifactsDir,
			sessionFile,
		});
	};

	// 后台并行完成：subagent_wait 的 completions（子代理会话文件可能在 artifactPaths.outputPath，须以 .jsonl 结尾）
	const completions = Array.isArray(d.completions) ? d.completions : [];
	for (const rawCompletion of completions) {
		const completion = rawCompletion as
			| { agent?: unknown; success?: unknown; results?: unknown[] }
			| undefined;
		if (!completion || !Array.isArray(completion.results)) continue;
		for (const rawChild of completion.results) {
			const child = rawChild as
				| {
						agent?: unknown;
						success?: unknown;
						error?: unknown;
						artifactPaths?: { jsonlPath?: unknown; outputPath?: unknown };
				  }
				| undefined;
			if (!child) continue;
			const outputPath =
				typeof child.artifactPaths?.outputPath === "string" ? child.artifactPaths.outputPath : undefined;
			const jsonlPath =
				typeof child.artifactPaths?.jsonlPath === "string" ? child.artifactPaths.jsonlPath : undefined;
			const sessionFile = jsonlPath ?? (outputPath?.endsWith(".jsonl") ? outputPath : undefined);
			pushRun(child.agent, {
				error: child.error,
				sessionFile,
				exitCode: child.success === false ? 1 : undefined,
			});
		}
	}

	// 同步/foreground：details.results[]（会话文件在 artifactPaths.jsonlPath）
	const results = Array.isArray(d.results) ? d.results : [];
	for (const raw of results) {
		const r = raw as Record<string, unknown>;
		const agent = typeof r.agent === "string" ? r.agent : undefined;
		const sessionFile = typeof r.sessionFile === "string" ? r.sessionFile : undefined;
		if (!agent && !sessionFile) continue;
		const artifactPaths = r.artifactPaths as { jsonlPath?: unknown } | undefined;
		const usage = r.usage as
			| { totalTokens?: { tokens?: unknown }; tokens?: unknown; input?: unknown; output?: unknown }
			| undefined;
		const progress = r.progressSummary as { tokens?: unknown } | undefined;
		const totalTokens = r.totalTokens as { tokens?: unknown } | undefined;
		const tokenValue =
			usage?.totalTokens?.tokens ??
			usage?.tokens ??
			(typeof usage?.input === "number" && typeof usage?.output === "number"
				? usage.input + usage.output
				: undefined) ??
			progress?.tokens ??
			totalTokens?.tokens;
		const exitCode = typeof r.exitCode === "number" ? r.exitCode : undefined;
		const error = typeof r.error === "string" && r.error.length > 0 ? r.error : undefined;
		pushRun(agent ?? sessionFile ?? "subagent", {
			task: r.task,
			model: r.model,
			exitCode,
			error,
			sessionFile:
				sessionFile ?? (typeof artifactPaths?.jsonlPath === "string" ? artifactPaths.jsonlPath : undefined),
			tokens: tokenValue,
		});
	}
	return runs.length > 0 ? runs : null;
}
