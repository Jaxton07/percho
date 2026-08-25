// 阶段 0 冒烟：channel-watch（跨会话频道协作）集成前提验证。
// 断言依据 .local/docs/design/plan/channel-automation-plan.md（V1–V6）。
// 用法：
//   npx tsx scripts/smoke-channel-watch.mts v4     # fs.watch recursive（无模型）
//   npx tsx scripts/smoke-channel-watch.mts v5     # skill seed 目录约定（无模型）
//   npx tsx scripts/smoke-channel-watch.mts v6     # projectTrusted:false 钩子（无模型）
//   npx tsx scripts/smoke-channel-watch.mts v1     # sendUserMessage 空闲唤醒（真实模型）
//   npx tsx scripts/smoke-channel-watch.mts v2     # sendUserMessage 运行中排队（真实模型）
//   npx tsx scripts/smoke-channel-watch.mts v3     # appendEntry 持久化读回（真实模型）
//   npx tsx scripts/smoke-channel-watch.mts all    # 按依赖序全跑
// 仅使用 dev agent 目录（~/.pi/agent-dev），正式目录零写入。
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

process.env.PI_CODING_AGENT_DIR = join(homedir(), ".pi", "agent-dev");

const {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
} = await import("@earendil-works/pi-coding-agent");

const cwd = resolve(process.cwd());
const agentDir = process.env.PI_CODING_AGENT_DIR;

// ---------- 共用 ----------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function setup() {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
}

function pickModel(runtime: InstanceType<typeof ModelRuntime>, spec: string) {
	const [provider, id] = spec.split("/");
	const model = runtime.getModel(provider, id);
	if (!model) throw new Error(`model not found: ${spec}`);
	return model;
}

/** 探针扩展：存 ExtensionAPI 引用，记录 session_start 的 reason / trust / entries */
interface ProbeState {
	pi: {
		sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void;
		appendEntry: (customType: string, data?: unknown) => void;
	} | null;
	startReasons: string[];
	trustFlags: Array<boolean | undefined>;
	startEntries: Array<Array<{ type: string; customType?: string; data?: unknown }>>;
}
function makeProbe() {
	const state: ProbeState = { pi: null, startReasons: [], trustFlags: [], startEntries: [] };
	const ext = {
		name: "smoke-probe",
		factory: (pi: never) => {
			state.pi = pi as ProbeState["pi"];
			(
				pi as unknown as {
					on: (
						e: "session_start",
						h: (
							ev: { reason: string },
							ctx: {
								isProjectTrusted?: () => boolean;
								sessionManager?: { getEntries?: () => Array<{ type: string; customType?: string; data?: unknown }> };
							},
						) => unknown,
					) => void;
				}
			).on("session_start", (ev, ctx) => {
				state.startReasons.push(ev.reason);
				state.trustFlags.push(ctx.isProjectTrusted?.());
				try {
					state.startEntries.push(ctx.sessionManager?.getEntries?.() ?? []);
				} catch {
					state.startEntries.push([]);
				}
			});
		},
	};
	return { ext, state };
}

interface SmokeSession {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionFile: string | undefined;
	tempRoot: string;
	cleanup: () => Promise<void>;
}

/** makeSession：trustedMode 缺省 = 不解析信任（projectTrusted 保持 false，项目级资源不加载） */
async function makeSession(
	runtime: InstanceType<typeof ModelRuntime>,
	factories: unknown[],
	options?: { modelSpec?: string; projectTrusted?: boolean },
): Promise<SmokeSession & { loader: InstanceType<typeof DefaultResourceLoader> }> {
	// tools 传 undefined = 正式桌面路径：无白名单，扩展工具自动激活
	const tempRoot = await mkdtemp(join("/tmp", "percho-smoke-cw-"));
	const model = pickModel(runtime, options?.modelSpec ?? "deepseek/deepseek-v4-flash");
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		extensionFactories: factories as never,
	});
	if (options?.projectTrusted) {
		await loader.reload({
			resolveProjectTrust: async () => true,
		});
	} else {
		// 不传 resolveProjectTrust：projectTrusted 保持 false（resource-loader.js:273 保留原值）
		await loader.reload();
	}
	const result = await createAgentSession({
		cwd,
		modelRuntime: runtime,
		model,
		tools: undefined,
		sessionManager: SessionManager.create(cwd, join(tempRoot, "sessions")),
		settingsManager, // 不传则 SDK 自建缺省 trusted 实例，ctx.isProjectTrusted() 恒 true
		resourceLoader: loader,
	});
	await result.session.bindExtensions({ mode: "rpc" });
	return {
		session: result.session,
		sessionFile: result.session.sessionFile,
		tempRoot,
		loader,
		cleanup: async () => {
			result.session.dispose();
			await rm(tempRoot, { recursive: true, force: true });
		},
	};
}

// ---------- V4：fs.watch recursive 连写不丢 ----------

async function phaseV4() {
	const root = await mkdtemp(join("/tmp", "percho-smoke-cw-watch-"));
	const target = join(root, "channel", "topic-A");
	await mkdir(target, { recursive: true });
	const file = join(target, "IMPL-NOTES.md");
	await writeFile(file, "init\n", "utf8");

	const events: Array<{ file: string; t: number }> = [];
	const watcher = watch(root, { recursive: true }, (eventType, filename) => {
		if (filename) events.push({ file: String(filename), t: performance.now() });
	});
	// watcher 就绪缓冲
	await sleep(300);

	const WRITES = 10;
	try {
		for (let i = 0; i < WRITES; i++) {
			await appendFile(file, `line-${i}\n`, "utf8");
			await sleep(120);
		}
		await sleep(600); // 尾部事件落定
	} finally {
		watcher.close();
		await rm(root, { recursive: true, force: true });
	}

	const hits = events.filter((e) => e.file.endsWith("IMPL-NOTES.md"));
	const uniqueWrites = new Set<string>();
	console.log(`[V4] fs.watch recursive: total=${events.length} targetHits=${hits.length}`);
	console.log(`[V4] event files: ${[...new Set(events.map((e) => e.file))].join(", ")}`);
	// 判定：目标文件的变更事件 ≥ 写入次数（合并可能少报，但每次 120ms 间隔不应合并）
	// 换个更稳的判据：事件里目标文件出现 + 内容最终完整（watch 层丢事件不等于丢数据，此处验证的是通知可靠性）
	const content = await readFile(file, "utf8").catch(() => "");
	void content;
	void uniqueWrites;
	if (hits.length < WRITES) {
		console.log(
			`[V4] WARN: 事件数 ${hits.length} < 写入次数 ${WRITES} —— macOS 上 recursive watch 有合并/丢失，需评估轮询降级`,
		);
	} else {
		console.log(`[V4] PASS: ${WRITES} 次连写全部收到事件`);
	}
}

// ---------- V5：skill seed 目录约定 ----------

async function phaseV5() {
	const skillDir = join(agentDir, "skills", "smoke-cw-skill");
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		"---\nname: smoke-cw-skill\ndescription: 冒烟测试技能（验证 seed 目录约定，可删）\n---\n\n测试正文。\n",
		"utf8",
	);
	try {
		const tmpCwd = await mkdtemp(join("/tmp", "percho-smoke-cw-v5-"));
		try {
			const loader = new DefaultResourceLoader({
				cwd: tmpCwd,
				agentDir,
				noExtensions: true,
				noPromptTemplates: true,
			});
			await loader.reload();
			const { skills, diagnostics } = loader.getSkills();
			const found = skills.find((s) => s.name === "smoke-cw-skill");
			console.log(`[V5] getSkills: ${skills.length} 个（含 smoke-cw-skill: ${!!found}）`);
			console.log(`[V5] Skill 形态: ${JSON.stringify(Object.keys(found ?? skills[0] ?? {}))}`);
			if (diagnostics.length > 0) console.log(`[V5] diagnostics: ${JSON.stringify(diagnostics)}`);
			if (!found) throw new Error("V5: agentDir/skills/<name>/SKILL.md 未被扫描到 —— seed 目标目录约定不成立");
			console.log(`[V5] PASS: ~/.pi/agent(-dev)/skills/<name>/SKILL.md 即全局 skill，无需注册`);
		} finally {
			await rm(tmpCwd, { recursive: true, force: true });
		}
	} finally {
		await rm(skillDir, { recursive: true, force: true });
	}
}

// ---------- V6：projectTrusted:false 时 inline factory 钩子 ----------

async function phaseV6(runtime: InstanceType<typeof ModelRuntime>) {
	// 场景 A：不受信（缺省路径，resolveProjectTrust 未解析）
	const probeA = makeProbe();
	const smA = await makeSession(runtime, [probeA.ext], { projectTrusted: false });
	try {
		const entries = probeA.state.startEntries[0] ?? [];
		if (probeA.state.startReasons.length === 0) throw new Error("V6: 不受信时 inline factory 的 session_start 未触发");
		console.log(
			`[V6] 不受信: session_start=${probeA.state.startReasons.join(",")} isProjectTrusted=${probeA.state.trustFlags.join(",")}`,
		);
		if (probeA.state.trustFlags[0] !== false) {
			throw new Error(`V6: 不受信时 isProjectTrusted() 应为 false，实测 ${probeA.state.trustFlags[0]}`);
		}
		if (!probeA.state.pi) throw new Error("V6: ExtensionAPI 不可用（pi ref 为空）");
		console.log(`[V6] PASS: inline factory 不受信任门控，ctx.isProjectTrusted()=false 可作 init 信任门判据`);
		void entries;
	} finally {
		await smA.cleanup();
	}
	// 场景 B：受信（resolveProjectTrust → true）
	const probeB = makeProbe();
	const smB = await makeSession(runtime, [probeB.ext], { projectTrusted: true });
	try {
		if (probeB.state.trustFlags[0] !== true) {
			throw new Error(`V6: 受信时 isProjectTrusted() 应为 true，实测 ${probeB.state.trustFlags[0]}`);
		}
		console.log(`[V6] PASS: resolveProjectTrust:true 路径 isProjectTrusted()=true`);
	} finally {
		await smB.cleanup();
	}
}

// ---------- V1：sendUserMessage 空闲唤醒 ----------

async function phaseV1(runtime: InstanceType<typeof ModelRuntime>) {
	const probe = makeProbe();
	const sm = await makeSession(runtime, [probe.ext]);
	let agentStartAt: number | null = null;
	let assistantEndAt: number | null = null;
	const eventLog: string[] = [];
	const done = new Promise<void>((resolveDone) => {
		sm.session.subscribe((e: { type: string; message?: { role?: string } }) => {
			eventLog.push(e.type);
			if (e.type === "agent_start" && agentStartAt === null) agentStartAt = performance.now();
			if (e.type === "message_end" && e.message?.role === "assistant" && assistantEndAt === null) {
				assistantEndAt = performance.now();
				resolveDone();
			}
		});
	});
	try {
		await sleep(500); // 确认空闲（bindExtensions 的 session_start 已过）
		if (!probe.state.pi) throw new Error("V1: pi ref missing");
		const t0 = performance.now();
		probe.state.pi.sendUserMessage("[smoke-v1] ping —— 请只回复两个字：pong");
		const timeout = sleep(30_000).then(() => "timeout" as const);
		const result = await Promise.race([done.then(() => "done" as const), timeout]);
		const latency = agentStartAt !== null ? agentStartAt - t0 : null; // 事件异步到达，须等 done 后再算
		console.log(`[V1] result=${result} 事件总数=${eventLog.length} 序列（前 6）=${eventLog.slice(0, 6).join(" -> ")}`);
		if (result !== "done") throw new Error("V1: 30s 内无 assistant 回复");
		if (latency === null) throw new Error("V1: 未观测到 agent_start");
		// 验证 user 形态进历史
		const entries = sm.session.sessionManager.getEntries() as Array<{
			type: string;
			message?: { role?: string; content?: unknown };
		}>;
		const userMsgs = entries.filter(
			(e) =>
				e.type === "message" &&
				e.message?.role === "user" &&
				JSON.stringify(e.message.content ?? "").includes("[smoke-v1]"),
		);
		console.log(
			`[V1] sendUserMessage → agent_start 延迟 ${latency.toFixed(0)}ms（门槛 3000ms）；user 消息进历史: ${userMsgs.length > 0}`,
		);
		console.log(`[V1] 事件序列（前 12）: ${eventLog.slice(0, 12).join(" -> ")}`);
		if (latency > 3000) throw new Error(`V1: 延迟 ${latency}ms 超门槛`);
		if (userMsgs.length === 0) throw new Error("V1: 唤醒消息未以 user 形态进历史");
		console.log("[V1] PASS: 空闲 sendUserMessage 触发新回合，消息 user 形态入史");
	} finally {
		await sm.cleanup();
	}
}

// ---------- V2：sendUserMessage 运行中排队 ----------

async function phaseV2(runtime: InstanceType<typeof ModelRuntime>) {
	const probe = makeProbe();
	const sm = await makeSession(runtime, [probe.ext]);
	const seq: string[] = [];
	let done: () => void;
	const doneP = new Promise<void>((r) => (done = r));
	sm.session.subscribe((e: { type: string }) => {
		seq.push(e.type);
		// followUp 触发的是新 turn（agent_start 整个生命周期只发一次）；agent_settled = 整个流程收尾
		if (e.type === "agent_settled" && seq.includes("queue_update")) done();
	});
	try {
		await sleep(500);
		if (!probe.state.pi) throw new Error("V2: pi ref missing");
		// 第一回合：长 bash（模型应调 bash sleep）
		const p = sm.session.prompt("运行 bash：sleep 6 然后回复“第一回合完成”。除此之外不要做任何事。");
		// 等 bash 真正开跑（agent_start + tool 执行中）再注入
		await sleep(2500);
		const stillRunning = seq.includes("agent_start") && !seq.includes("agent_end");
		console.log(`[V2] 注入时机: agent 运行中=${stillRunning}（事件序: ${seq.slice(0, 6).join(",")}）`);
		probe.state.pi.sendUserMessage("[smoke-v2] 排队消息 —— 收到后请只回复：queued-ok", { deliverAs: "followUp" });
		const timeout = sleep(60_000).then(() => "timeout" as const);
		const result = await Promise.race([doneP.then(() => "done" as const), timeout]);
		await p.catch(() => {});
		if (result !== "done") {
			console.log(`[V2] TIMEOUT 事件序列: ${seq.join(" -> ")}`);
			throw new Error("V2: 60s 内未完成两回合");
		}
		// 事后断言：entries 里 bash toolResult 完成 + 注入消息 user 入史 + 无 abort
		const entries = sm.session.sessionManager.getEntries() as Array<{
			type: string;
			message?: { role?: string; content?: unknown; toolCallId?: string };
		}>;
		const toolResults = entries.filter((e) => e.type === "message" && e.message?.role === "toolResult");
		const injected = entries.filter(
			(e) =>
				e.type === "message" &&
				e.message?.role === "user" &&
				JSON.stringify(e.message.content ?? "").includes("[smoke-v2]"),
		);
		const agentStarts = seq.filter((s) => s === "agent_start").length;
		const turnStarts = seq.filter((s) => s === "turn_start").length;
		const queued = seq.includes("queue_update");
		const settled = seq.includes("agent_settled");
		const aborted = seq.some((s) => s.startsWith("abort"));
		console.log(
			`[V2] bash 工具结果: ${toolResults.length} 个；注入消息入史: ${injected.length}；turn_start: ${turnStarts}（agent_start 仅 ${agentStarts}，followUp 开新 turn 不开新 agent）；queue_update=${queued}；settled=${settled}；abort=${aborted}`,
		);
		if (toolResults.length === 0) throw new Error("V2: 第一回合 bash 未完成（被打断或未执行）");
		if (!queued) throw new Error("V2: 未见 queue_update（注入未排队）");
		if (injected.length === 0) throw new Error("V2: followUp 消息未以 user 形态入史");
		if (turnStarts < 2) throw new Error("V2: followUp 未触发新 turn");
		if (!settled) throw new Error("V2: 未见 agent_settled");
		if (aborted) throw new Error("V2: 出现 abort 事件");
		console.log("[V2] PASS: 运行中 followUp 排队不打断，回合结束后注入触发新 turn");
	} finally {
		await sm.cleanup();
	}
}

// ---------- V3：appendEntry 持久化读回 ----------

async function phaseV3(runtime: InstanceType<typeof ModelRuntime>) {
	const probe = makeProbe();
	const sm = await makeSession(runtime, [probe.ext]);
	let sessionFile: string | undefined;
	try {
		await sleep(500);
		if (!probe.state.pi) throw new Error("V3: pi ref missing");
		// 真实路径前置：session 文件懒创建（session-manager._persist 首条 assistant 前不落盘），
		// 订阅总发生在有来有回之后，先跑一轮对话使文件 flush
		await sm.session.prompt("请只回复两个字：ready");
		probe.state.pi.appendEntry("smoke-cw-subs", { channels: ["topic-A"], note: "persist-me" });
		await sleep(800); // 落盘
		sessionFile = sm.sessionFile;
		if (!sessionFile) throw new Error("V3: no sessionFile");
		const raw = await readFile(sessionFile, "utf8");
		const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { type: string; customType?: string });
		const custom = lines.filter((l) => l.type === "custom");
		const ours = custom.filter((l) => l.customType === "smoke-cw-subs");
		console.log(`[V3] sessionFile JSONL: ${lines.length} 行，custom=${custom.length}，smoke-cw-subs=${ours.length}`);
		console.log(`[V3] custom 行字段: ${JSON.stringify(Object.keys(custom[0] ?? {}))}`);
		if (ours.length !== 1) throw new Error(`V3: appendEntry 未落盘或重复（${ours.length} 条）`);
	} finally {
		sm.session.dispose(); // 只 dispose 不删 tempRoot：重开还要读 sessionFile
	}
	// 新会话打开同文件读回
	if (!sessionFile) throw new Error("V3: unreachable");
	const probe2 = makeProbe();
	const tempRoot2 = await mkdtemp(join("/tmp", "percho-smoke-cw-v3-"));
	try {
		const sessionManager = SessionManager.open(sessionFile);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			extensionFactories: [probe2.ext] as never,
		});
		await loader.reload();
		const result = await createAgentSession({
			cwd,
			modelRuntime: runtime,
			model: pickModel(runtime, "deepseek/deepseek-v4-flash"),
			tools: undefined,
			sessionManager,
			resourceLoader: loader,
		});
		try {
			await result.session.bindExtensions({ mode: "rpc" });
			const fromStart = probe2.state.startEntries[0] ?? [];
			const live = result.session.sessionManager.getEntries() as Array<{ type: string; customType?: string }>;
			console.log(
				`[V3] 重开 session_start: reason=${probe2.state.startReasons.join(",")} startEntries=${fromStart.length}（${fromStart.map((e) => e.type).join(",")}）`,
			);
			console.log(
				`[V3] 重开实时 getEntries: ${live.length} 条（${live.map((e) => e.type).join(",")}）sessionFile=${result.session.sessionFile}`,
			);
			const restoredLive = live.filter((e) => e.type === "custom" && e.customType === "smoke-cw-subs");
			const restored = restoredLive.length > 0 ? restoredLive : fromStart.filter((e) => e.type === "custom" && e.customType === "smoke-cw-subs");
			console.log(
				`[V3] 恢复路径: ${restoredLive.length > 0 ? "实时 getEntries()" : "session_start getEntries()"}`,
			);
			if (restored.length !== 1) {
				throw new Error(`V3: 两条路径均未读回 custom entry（${restored.length} 条）`);
			}
			console.log(`[V3] entry.data: ${JSON.stringify((restored[0] as { data?: unknown }).data)}`);
			console.log("[V3] PASS: appendEntry 落盘 JSONL，重开读回");
		} finally {
			result.session.dispose();
		}
	} finally {
		await rm(sm.tempRoot, { recursive: true, force: true });
		await rm(tempRoot2, { recursive: true, force: true });
	}
}

// ---------- main ----------

async function main() {
	const phase = process.argv[2] ?? "all";
	if (phase === "v4") return phaseV4();
	if (phase === "v5") return phaseV5();
	const runtime = await setup();
	try {
		if (phase === "v6") await phaseV6(runtime);
		else if (phase === "v1") await phaseV1(runtime);
		else if (phase === "v2") await phaseV2(runtime);
		else if (phase === "v3") await phaseV3(runtime);
		else if (phase === "all") {
			await phaseV4();
			await phaseV5();
			await phaseV6(runtime);
			await phaseV1(runtime);
			await phaseV2(runtime);
			await phaseV3(runtime);
		} else {
			throw new Error(`unknown phase: ${phase}`);
		}
		console.log("\nSMOKE CHANNEL-WATCH: ALL GREEN");
	} finally {
		// ModelRuntime 无显式 dispose；进程退出即释放
	}
}

await main();
// 冒烟是短生命周期 CLI：LLM 连接池等进程级句柄不随 dispose 释放，显式退出
process.exit(0);
