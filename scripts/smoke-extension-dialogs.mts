/**
 * 冒烟：扩展对话框宿主端到端（plan extension-dialogs 阶段 0.1，非 vitest）。
 *
 * 零 LLM 调用、零凭证：inline 测试扩展的命令直调 ctx.ui.*，SDK 在模型校验前分发扩展命令
 * （agent-session.js prompt() 首分支），因此全程离线。PI_CODING_AGENT_DIR 指向临时目录，
 * 正式 ~/.pi/agent/ 零写入（cwd 与会话目录同样落在临时目录）。
 *
 * 断言（plan 0.1 三条）：
 *   1. host 收到请求的 kind/title/options/timeoutMs 与契约一致；
 *   2. timeout 到点自动 resolve 取消值（select→undefined、confirm→false），误差 ±300ms；
 *   3. signal.abort() → 立即 resolve 取消值（<100ms）。
 *
 * 运行：npx tsx scripts/smoke-extension-dialogs.mts
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// type-only：编译期擦除，不影响下方 env 隔离先于 SDK 值导入的顺序
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionDialogRequest } from "@percho/shared";

// 环境隔离必须先于任何 SDK 模块执行（getAgentDir 惰性读 env，但动态 import 是零成本保险）
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "percho-smoke-extdlg-"));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

const {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { ExtensionDialogHost } = await import("../packages/backend/src/session/extension-dialog-host.ts");
const { makeUiContext } = await import("../packages/backend/src/session/ui-context.ts");

const SELECT_TITLE = "覆盖现有配置？";
const SELECT_OPTIONS = ["继续覆盖", "先备份再覆盖"];

/** 命令 handler 与断言侧共享的记录（结果/计时/控制器） */
const R = {
	shape: null as Awaited<ReturnType<typeof shapeCmd>> | null,
	selectTimeout: { startedAt: 0, doneAt: 0, result: undefined as string | undefined | null },
	confirmTimeout: { startedAt: 0, doneAt: 0, result: undefined as boolean | null },
	abort: { ctrl: null as AbortController | null, startedAt: 0, doneAt: 0, result: undefined as string | undefined | null },
};

async function shapeCmd(ctx: ExtensionCommandContext) {
	const result = await ctx.ui.select("smoke shape", ["a", "b"]);
	return { result, mode: ctx.mode, hasUI: ctx.hasUI };
}

const extension = {
	name: "smoke-dlg",
	hidden: true,
	factory: (pi: ExtensionAPI) => {
		pi.registerCommand("smoke-shape", {
			description: "shape",
			handler: async (_args, ctx) => {
				R.shape = await shapeCmd(ctx);
			},
		});
		pi.registerCommand("smoke-select-timeout", {
			description: "select timeout",
			handler: async (_args, ctx) => {
				R.selectTimeout.startedAt = Date.now();
				const result = await ctx.ui.select(SELECT_TITLE, SELECT_OPTIONS, { timeout: 800 });
				R.selectTimeout.doneAt = Date.now();
				R.selectTimeout.result = result;
			},
		});
		pi.registerCommand("smoke-confirm-timeout", {
			description: "confirm timeout",
			handler: async (_args, ctx) => {
				R.confirmTimeout.startedAt = Date.now();
				const result = await ctx.ui.confirm("确认清除缓存？", "不可撤销。", { timeout: 800 });
				R.confirmTimeout.doneAt = Date.now();
				R.confirmTimeout.result = result;
			},
		});
		pi.registerCommand("smoke-select-abort", {
			description: "select abort",
			handler: async (_args, ctx) => {
				R.abort.ctrl = new AbortController();
				R.abort.startedAt = Date.now();
				const result = await ctx.ui.select("中止语义", ["x", "y"], { signal: R.abort.ctrl.signal });
				R.abort.doneAt = Date.now();
				R.abort.result = result;
			},
		});
	},
};

function fail(message: string): never {
	console.error(`FAIL ${message}`);
	process.exit(1);
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) fail(`等待超时：${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function main() {
	const runtime = await ModelRuntime.create();
	const cwd = await mkdtemp(join(tmpdir(), "percho-smoke-extdlg-cwd-"));
	const settingsManager = SettingsManager.create(cwd, AGENT_DIR, { projectTrusted: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: AGENT_DIR,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		extensionFactories: [extension],
	});
	await resourceLoader.reload();

	/** host 收到的请求（onRequest 回调注入，与 GUI 链路同源） */
	const requests: ExtensionDialogRequest[] = [];
	const host = new ExtensionDialogHost({
		onRequest: (req) => requests.push(req),
		onResolved: () => {},
	});

	const { session } = await createAgentSession({
		cwd,
		modelRuntime: runtime,
		tools: [],
		sessionManager: SessionManager.create(cwd, join(AGENT_DIR, "sessions")),
		settingsManager,
		resourceLoader,
	});

	host.bind(session.sessionId);
	const errors: unknown[] = [];
	await session.bindExtensions({
		uiContext: makeUiContext({ dialogs: host }),
		mode: "rpc",
		onError: (err) => errors.push(err),
	});

	// ---- 断言 1：请求形状（kind/title/options/timeoutMs/sessionId）----
	void session.prompt("/smoke-select-timeout");
	await waitFor(() => requests.length > 0, "host 收到 select 请求");
	const req = requests[0];
	if (req.kind !== "select") fail(`kind=${req.kind}`);
	if (req.title !== SELECT_TITLE) fail(`title=${req.title}`);
	if (JSON.stringify(req.options) !== JSON.stringify(SELECT_OPTIONS)) fail(`options=${JSON.stringify(req.options)}`);
	if (req.timeoutMs !== 800) fail(`timeoutMs=${req.timeoutMs}`);
	if (req.sessionId !== session.sessionId) fail(`sessionId=${req.sessionId}`);
	if (typeof req.requestedAt !== "number") fail("requestedAt 缺失");
	console.log("PASS 1 请求形状与契约一致", JSON.stringify({ ...req, title: undefined }));

	// ---- 断言 2a：select 超时 → undefined（800ms ±300）----
	await waitFor(() => R.selectTimeout.doneAt > 0, "select 超时 resolve");
	const selectElapsed = R.selectTimeout.doneAt - R.selectTimeout.startedAt;
	if (R.selectTimeout.result !== undefined) fail(`select 超时返回 ${JSON.stringify(R.selectTimeout.result)}`);
	if (selectElapsed < 500 || selectElapsed > 1100) fail(`select 超时耗时 ${selectElapsed}ms`);
	console.log(`PASS 2a select 超时 → undefined（${selectElapsed}ms）`);

	// ---- 断言 1b：confirm 请求形状（无 options）----
	void session.prompt("/smoke-confirm-timeout");
	await waitFor(() => requests.length > 1, "host 收到 confirm 请求");
	const confirmReq = requests[1];
	if (confirmReq.kind !== "confirm") fail(`confirm kind=${confirmReq.kind}`);
	if (confirmReq.options !== undefined) fail(`confirm options=${JSON.stringify(confirmReq.options)}`);

	// ---- 断言 2b：confirm 超时 → false（800ms ±300）----
	await waitFor(() => R.confirmTimeout.doneAt > 0, "confirm 超时 resolve");
	const confirmElapsed = R.confirmTimeout.doneAt - R.confirmTimeout.startedAt;
	if (R.confirmTimeout.result !== false) fail(`confirm 超时返回 ${JSON.stringify(R.confirmTimeout.result)}`);
	if (confirmElapsed < 500 || confirmElapsed > 1100) fail(`confirm 超时耗时 ${confirmElapsed}ms`);
	console.log(`PASS 2b confirm 超时 → false（${confirmElapsed}ms）`);

	// ---- 断言 3：signal.abort() → <100ms resolve 取消值 ----
	void session.prompt("/smoke-select-abort");
	await waitFor(() => requests.length > 2, "host 收到 abort select 请求");
	await new Promise((r) => setTimeout(r, 50));
	const abortAt = Date.now();
	R.abort.ctrl?.abort();
	await waitFor(() => R.abort.doneAt > 0, "abort 后 resolve");
	const abortLatency = R.abort.doneAt - abortAt;
	if (R.abort.result !== undefined) fail(`abort 返回 ${JSON.stringify(R.abort.result)}`);
	if (abortLatency >= 100) fail(`abort 延迟 ${abortLatency}ms（要求 <100ms）`);
	console.log(`PASS 3 signal.abort → undefined（${abortLatency}ms）`);

	// ---- 断言 4（加菜）：用户应答路径 + ctx.mode/hasUI 语义 ----
	// shape 的 select 无 timeout/signal，永不自 settle：fire → 等 host 收到请求 → 代答 → 验证回链
	void session.prompt("/smoke-shape");
	await waitFor(() => requests.length > 3, "host 收到 shape select 请求");
	const shapeReq = requests[3];
	host.respond(shapeReq.id, { value: "a" });
	await waitFor(() => R.shape !== null, "shape select resolve");
	if (R.shape?.result !== "a") fail(`应答返回 ${JSON.stringify(R.shape?.result)}`);
	if (R.shape?.mode !== "rpc") fail(`ctx.mode=${R.shape?.mode}`);
	if (R.shape?.hasUI !== true) fail(`ctx.hasUI=${R.shape?.hasUI}`);
	console.log(`PASS 4 用户应答 → "${R.shape?.result}"；mode=rpc / hasUI=true`);

	try {
		session.dispose();
	} catch {
		// 清理失败不影响结果
	}
	console.log("\nALL GREEN — 扩展对话框宿主端到端语义（含临时目录隔离）");
}

main().catch((err) => {
	console.error("SMOKE ERROR", err);
	process.exit(1);
});
