// 阶段 0 冒烟：真实 SDK 验证进程内子会话的 loader、目录隔离、开销和事件/usage。
// 仅使用 dev agent 目录，避免正式 ~/.pi/agent/ 被写入；需要已有凭证才能执行真实任务。
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

process.env.PI_CODING_AGENT_DIR = join(homedir(), ".pi", "agent-dev");

const {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	createAgentSession,
} = await import("@earendil-works/pi-coding-agent");

const cwd = resolve(process.cwd());
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required");

const tempRoot = await mkdtemp(join("/tmp", "percho-smoke-subagent-"));
const childSessionDir = join(tempRoot, "subagents");
const injectedPrompt = "你是 scout，只读侦察。";
let session: InstanceType<typeof import("@earendil-works/pi-coding-agent").AgentSession> | undefined;

try {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const available = await runtime.getAvailable();
	const model = available[0];
	if (!model) {
		throw new Error("No authenticated model available in ~/.pi/agent-dev; configure dev credentials before running smoke-subagent");
	}

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		appendSystemPrompt: [injectedPrompt],
	});
	await loader.reload();

	const parentSessionsBefore = await SessionManager.listAll();
	const createStarted = performance.now();
	const result = await createAgentSession({
		cwd,
		modelRuntime: runtime,
		model,
		tools: ["read"],
		sessionManager: SessionManager.create(cwd, childSessionDir),
		resourceLoader: loader,
	});
	const createMs = performance.now() - createStarted;
	if (createMs >= 500) throw new Error(`createAgentSession took ${Math.round(createMs)}ms (expected < 500ms)`);
	session = result.session;

	if (!session.systemPrompt.includes(injectedPrompt)) {
		throw new Error("appendSystemPrompt was not included in the child session system prompt");
	}
	const parentSessionsAfterCreate = await SessionManager.listAll();
	const childPathAppearedInParentList = parentSessionsAfterCreate.some((entry) => entry.path.startsWith(childSessionDir));
	if (childPathAppearedInParentList) {
		throw new Error("child session appeared in SessionManager.listAll() default session directory");
	}

	let agentEnd = false;
	let messageEndCount = 0;
	let usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end") {
			messageEndCount++;
			const usage = (event as {
				message?: {
					usage?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
						cost?: { total?: number };
					};
				};
			}).message?.usage;
			if (usage) {
				usageTotals = {
					input: usageTotals.input + (usage.input ?? 0),
					output: usageTotals.output + (usage.output ?? 0),
					cacheRead: usageTotals.cacheRead + (usage.cacheRead ?? 0),
					cacheWrite: usageTotals.cacheWrite + (usage.cacheWrite ?? 0),
					cost: usageTotals.cost + (usage.cost?.total ?? 0),
				};
			}
		}
		if (event.type === "agent_end") agentEnd = true;
	});

	await session.prompt(
		`请读取 ${join(cwd, "AGENTS.md")}，用三句话总结其中与子代理实现最相关的约束。不要修改任何文件。`,
	);
	unsubscribe();

	if (!agentEnd) throw new Error("agent_end was not observed");
	if (messageEndCount === 0) throw new Error("message_end was not observed");

	const parentSessionsAfterRun = await SessionManager.listAll();
	const childPathAppearedAfterRun = parentSessionsAfterRun.some((entry) => entry.path.startsWith(childSessionDir));
	if (childPathAppearedAfterRun) {
		throw new Error("child session appeared in SessionManager.listAll() after the run");
	}

	console.log(JSON.stringify({
		ok: true,
		createMs: Math.round(createMs),
		createUnder500ms: createMs < 500,
		appendSystemPrompt: true,
		directoryIsolated: !childPathAppearedInParentList && !childPathAppearedAfterRun,
		agentEnd,
		messageEndCount,
		usageTotals,
		parentSessionCountBefore: parentSessionsBefore.length,
		parentSessionCountAfter: parentSessionsAfterRun.length,
		sessionFile: session.sessionFile,
	}, null, 2));
} finally {
	session?.dispose();
	await rm(tempRoot, { recursive: true, force: true });
}

// 冒烟是短生命周期 CLI：LLM 连接池（undici keep-alive）等进程级共享句柄不随子会话 dispose
// 释放（桌面端主进程常驻，同一连接池本就一直持有，非每 run 泄漏）；脚本到此显式退出。
process.exit(0);
