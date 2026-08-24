// 阶段 0 冒烟：ACP（模型驱动上下文压缩）集成前提验证。
// 断言依据 .local/docs/design/plan/acp-context-plan.md（V1/V2/V3/V6）。
// 用法：
//   npx tsx scripts/smoke-acp.mts v6
//   npx tsx scripts/smoke-acp.mts v2
//   npx tsx scripts/smoke-acp.mts v1
//   npx tsx scripts/smoke-acp.mts v3 [provider/id ...]   # 默认 kimi-coding/k3 + deepseek/deepseek-v4-flash
// 仅使用 dev agent 目录（~/.pi/agent-dev），正式目录零写入。
import { mkdtemp, rm, writeFile, rename, readFile } from "node:fs/promises";
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
const acp = await import("acp-kernel");

const cwd = resolve(process.cwd());
const agentDir = process.env.PI_CODING_AGENT_DIR;

// ---------- 共用小工具 ----------

interface TextBlockLike {
	type: "text";
	text: string;
}
interface ToolCallBlockLike {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
type AgentMessageLike = {
	role: string;
	content?: string | Array<{ type: string; [k: string]: unknown }>;
	[k: string]: unknown;
};

const TAG_RE = /^<acp[^>]*>m\d{1,5}<\/acp>\n?/;

function extractText(content: unknown): string {
	if (typeof content === "string") return content.replace(TAG_RE, "");
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text.replace(TAG_RE, ""));
	}
	return parts.join("\n");
}

function stringifyArgs(args: unknown): string {
	if (args == null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

/** entries → acp CoreMessage[]（smoke 简化版 bridge：拆分多工具调用 assistant） */
function entriesToCoreMessages(
	entries: Array<{ type: string; id: string; message?: AgentMessageLike; content?: unknown; summary?: string }>,
): acp.CoreMessage[] {
	const out: acp.CoreMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "custom_message") {
			const text = extractText(entry.content);
			if (text.length > 0) out.push({ id: entry.id, role: "user", contentType: "text", text });
			continue;
		}
		if (entry.type === "compaction" && entry.summary) {
			out.push({ id: entry.id, role: "user", contentType: "text", text: entry.summary });
			continue;
		}
		if (entry.type === "branch_summary" && entry.summary) {
			out.push({ id: entry.id, role: "user", contentType: "text", text: entry.summary });
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		const id = entry.id;
		if (msg.role === "user") {
			out.push({ id, role: "user", contentType: "text", text: extractText(msg.content) });
		} else if (msg.role === "toolResult") {
			out.push({
				id,
				role: "tool",
				contentType: "tool-result",
				toolName: msg.toolName as string,
				toolCallId: msg.toolCallId as string,
				text: extractText(msg.content),
			});
		} else if (msg.role === "assistant") {
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			const calls = blocks.filter(
				(b): b is ToolCallBlockLike => (b as { type?: string }).type === "toolCall",
			);
			const textParts = extractText(msg.content);
			if (calls.length === 0) {
				if (textParts.trim()) out.push({ id, role: "assistant", contentType: "text", text: textParts });
			} else if (calls.length === 1) {
				const argStr = stringifyArgs(calls[0].arguments);
				out.push({
					id,
					role: "assistant",
					contentType: "tool-call",
					toolName: calls[0].name,
					toolCallId: calls[0].id,
					text: argStr && textParts ? `${textParts}\n${argStr}` : argStr || textParts,
				});
			} else {
				for (const call of calls) {
					out.push({
						id: `${id}#${call.id}`,
						role: "assistant",
						contentType: "tool-call",
						toolName: call.name,
						toolCallId: call.id,
						text: stringifyArgs(call.arguments),
					});
				}
			}
		} else {
			// bashExecution / custom 等其它角色：投影为 user 文本
			const text = extractText(msg.content) || stringifyArgs(msg.command) || "";
			if (text.trim()) out.push({ id, role: "user", contentType: "text", text });
		}
	}
	return out;
}

/** processTurn 输出 → pi AgentMessage[]（smoke 简化版：摘要→CustomMessage + 标签回注 + 截断传播省略） */
function coreOutToAgentMessages(
	coreOut: acp.CoreMessage[],
	originalById: Map<string, AgentMessageLike>,
): AgentMessageLike[] {
	const out: AgentMessageLike[] = [];
	const emittedSplit = new Set<string>();
	for (const core of coreOut) {
		if (core.id.startsWith("acp_summary_")) {
			// 摘要消息：CustomMessage 承载（convertToLlm → user role，display:false 不进 UI）
			out.push({
				role: "custom",
				customType: "acp-summary",
				content: core.text ?? "",
				display: false,
				details: { blockId: core.id.slice("acp_summary_".length) },
				timestamp: Date.now(),
			});
			continue;
		}
		const hashIdx = core.id.indexOf("#");
		const tagMatch = core.text?.match(TAG_RE)?.[0] ?? null;
		if (hashIdx < 0) {
			const original = originalById.get(core.id);
			if (original) out.push(withTag(original, tagMatch));
			continue;
		}
		const baseId = core.id.slice(0, hashIdx);
		if (emittedSplit.has(baseId)) continue;
		emittedSplit.add(baseId);
		const original = originalById.get(baseId);
		if (!original) continue;
		const survivingCallIds = new Set(
			coreOut
				.filter((c) => c.id.startsWith(`${baseId}#`))
				.map((c) => c.toolCallId)
				.filter((id): id is string => !!id),
		);
		const blocks = Array.isArray(original.content) ? [...original.content] : [];
		const filtered = blocks.filter(
			(b) => (b as { type?: string }).type !== "toolCall" || survivingCallIds.has((b as ToolCallBlockLike).id),
		);
		out.push(withTag({ ...original, content: filtered }, tagMatch));
	}
	return out;
}

/** 把 <acp> 标签注入原消息最后一个 text block（模型需要看到 ref 坐标系） */
function withTag(original: AgentMessageLike, tag: string | null): AgentMessageLike {
	if (!tag) return original;
	if (typeof original.content === "string") {
		return { ...original, content: `${original.content.replace(/\n*$/, "")}\n\n${tag}` };
	}
	if (Array.isArray(original.content)) {
		const blocks = original.content.map((b) => ({ ...b }));
		for (let i = blocks.length - 1; i >= 0; i--) {
			const b = blocks[i] as { type?: string; text?: string };
			if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
				b.text = `${b.text.replace(/\n*$/, "")}\n\n${tag}`;
				return { ...original, content: blocks };
			}
		}
		return { ...original, content: [...blocks, { type: "text", text: tag }] };
	}
	return { ...original, content: [{ type: "text", text: tag }] };
}

/** event.messages（structuredClone 后的上下文）按 index 与 entries 派生消息序列对齐，保住上游钩子的变换 */
function alignOriginals(
	entries: Array<{ type: string; id: string; message?: AgentMessageLike; content?: unknown }>,
	eventMessages: AgentMessageLike[],
): { originals: Map<string, AgentMessageLike>; aligned: boolean } {
	const originals = new Map<string, AgentMessageLike>();
	let aligned = false;
	// 先投影成消息序列（排除 thinking_level_change 等非消息 entry）再对齐
	const projected = projectEntries(entries);
	if (eventMessages.length === projected.length) {
		aligned = true;
		for (let i = 0; i < projected.length; i++) {
			const live = eventMessages[i];
			if (!live || live.role !== projected[i].msg.role) {
				aligned = false;
				break;
			}
			originals.set(projected[i].id, live);
		}
	}
	if (!aligned) {
		originals.clear();
		for (const p of projected) originals.set(p.id, p.msg);
	}
	return { originals, aligned };
}

/** entries → [{id, msg}]（对齐 sessionEntryToContextMessages 的映射，供 index 对齐用） */
function projectEntries(
	entries: Array<{ type: string; id: string; message?: AgentMessageLike; content?: unknown; summary?: string }>,
): Array<{ id: string; msg: AgentMessageLike }> {
	const out: Array<{ id: string; msg: AgentMessageLike }> = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message) out.push({ id: entry.id, msg: entry.message });
		else if (entry.type === "custom_message")
			out.push({
				id: entry.id,
				msg: {
					role: "custom",
					customType: (entry as { customType?: string }).customType ?? "acp",
					content: entry.content ?? "",
					display: false,
					timestamp: Date.now(),
				},
			});
		else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.summary)
			out.push({ id: entry.id, msg: { role: entry.type, summary: entry.summary, timestamp: Date.now() } });
	}
	return out;
}

async function saveState(sessionFile: string | undefined, state: acp.CompressionState) {
	if (!sessionFile) return;
	const file = `${sessionFile}.acp.json`;
	const tmp = join(join(file, ".."), `.acp-tmp-${Math.random().toString(36).slice(2)}`);
	await writeFile(tmp, JSON.stringify(state), "utf8");
	await rename(tmp, file);
}

// ---------- 环境准备 ----------

async function setup() {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	return runtime;
}

function pickModel(runtime: InstanceType<typeof ModelRuntime>, spec: string) {
	const [provider, id] = spec.split("/");
	const model = runtime.getModel(provider, id);
	if (!model) throw new Error(`model not found: ${spec}`);
	return model;
}

interface SmokeSession {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionFile: string | undefined;
	loader: InstanceType<typeof DefaultResourceLoader>;
	cleanup: () => Promise<void>;
}

async function makeSession(
	runtime: InstanceType<typeof ModelRuntime>,
	modelSpec: string,
	factories: unknown[],
	tools: string[] | undefined,
): Promise<SmokeSession> {
	// tools 不传（undefined）= 正式桌面路径：无白名单，扩展 registerTool 工具自动激活
	// （传数组会变成允许清单，把扩展工具直接过滤掉 —— sdk.js:133 isAllowedTool）
	const tempRoot = await mkdtemp(join("/tmp", "percho-smoke-acp-"));
	const model = pickModel(runtime, modelSpec);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		extensionFactories: factories as never,
	});
	await loader.reload();
	const result = await createAgentSession({
		cwd,
		modelRuntime: runtime,
		model,
		tools,
		sessionManager: SessionManager.create(cwd, join(tempRoot, "sessions")),
		resourceLoader: loader,
	});
	await result.session.bindExtensions({ mode: "rpc" });
	return {
		session: result.session,
		sessionFile: result.session.sessionFile,
		loader,
		cleanup: async () => {
			result.session.dispose();
			await rm(tempRoot, { recursive: true, force: true });
		},
	};
}

// ---------- V6：import 形态 ----------

function assertV6() {
	const core = acp.createCore();
	const state = acp.createInitialState();
	const config = acp.defaultConfig(256000);
	if (typeof core.processTurn !== "function") throw new Error("V6: createCore().processTurn missing");
	if (!Array.isArray(state.blocks) || !state.messageRefs) throw new Error("V6: createInitialState shape");
	if (config.modelContextLimit !== 256000) throw new Error("V6: defaultConfig limit");
	if (typeof acp.COMPRESS_TOOL.description !== "string" || !acp.COMPRESS_TOOL.description) {
		throw new Error("V6: COMPRESS_TOOL.description missing");
	}
	console.log("[V6] acp-kernel import under tsx OK; createCore/createInitialState/defaultConfig OK");
}

// ---------- V2：context 钩子链顺序 ----------

async function phaseV2(runtime: InstanceType<typeof ModelRuntime>) {
	const order: string[] = [];
	const CHAIN_MARKER = "v2-chain-passthrough";
	const makeProbe = (name: string, mutate: boolean): { name: string; factory: (pi: unknown) => void } => ({
		name,
		factory: (pi) => {
			(pi as { on: (e: string, h: (ev: { messages: AgentMessageLike[] }) => unknown) => void }).on(
				"context",
				(event) => {
					order.push(name);
					if (!mutate) return undefined;
					// 链式语义验证：替换数组并在末尾追加标记消息，下一个 handler 应看到
					const messages = [...event.messages];
					const last = messages[messages.length - 1];
					if (last && typeof last === "object") {
						messages[messages.length - 1] = { ...last, __chainMarker: CHAIN_MARKER };
					}
					return { messages };
				},
			);
		},
	});
	// 复刻 pi-backend.buildExtensionFactories 当前注册序（todo-reminder 最前，vision 最后），
	// ACP 探针插在设想位（vision 之后）。todo-reminder 外包一层日志探针（handler 提前 return 也算命中）。
	const { makeTodoReminderExtension } = await import("../packages/backend/src/tools/todo-reminder.ts");
	const todoReminder = makeTodoReminderExtension();
	const wrappedTodo: { name: string; factory: (pi: never) => void | Promise<void> } = {
		name: "todo-reminder",
		factory: (pi) => {
			(pi as unknown as { on: (e: string, h: (ev: unknown) => unknown) => void }).on("context", () => {
				order.push("todo-reminder");
			return undefined;
			});
			return (todoReminder as { factory: (pi: never) => void | Promise<void> }).factory(pi);
		},
	};
	const factories: unknown[] = [wrappedTodo, makeProbe("vision-sim", true), makeProbe("acp-sim", false)];
	let acpSawMarker = false;
	// acp-sim 探针检查是否看到上游替换的消息（链式语义验证），必须在 makeSession 之前就绪
	const acpProbe = makeProbe("acp-sim", false);
	const acpFactory = acpProbe.factory;
	acpProbe.factory = (pi) => {
		(pi as unknown as { on: (e: string, h: (ev: { messages: AgentMessageLike[] }) => unknown) => void }).on(
			"context",
			(event) => {
				const last = event.messages[event.messages.length - 1] as { __chainMarker?: string } | undefined;
				if (last && last.__chainMarker === CHAIN_MARKER) acpSawMarker = true;
				return undefined;
			},
		);
		acpFactory(pi);
	};
	factories[2] = acpProbe;
	const sm = await makeSession(runtime, "deepseek/deepseek-v4-flash", factories, undefined);
	try {
		await sm.session.prompt("用一个字回答：1+1=?（不要用工具）");
	} finally {
		await sm.cleanup();
	}
	console.log(`[V2] context hook order: ${order.join(" -> ")}`);
	const uniqueOrder = [...new Set(order)];
	const expected = ["todo-reminder", "vision-sim", "acp-sim"];
	const ok = expected.every((name, i) => uniqueOrder[i] === name);
	if (!ok) {
		throw new Error(`V2: context hook order unexpected: ${uniqueOrder.join(" -> ")} (expected ${expected.join(" -> ")})`);
	}
	if (!acpSawMarker) throw new Error("V2: later handler did not see earlier handler's replaced messages (chain broken)");
	console.log("[V2] 链式语义 OK（handler 返回 {messages} 替换后传给下一个扩展）");
	console.log("[V2] 结论：当前注册序 todo-reminder 在最前 —— T7 需要把它挪到 vision/ACP 之后（对齐 spec D8）");
}

// ---------- V1：processTurn 端到端 ----------

async function phaseV1(runtime: InstanceType<typeof ModelRuntime>) {
	const stats = { contextCalls: 0, refs: 0, turnMsMax: 0, alignedCalls: 0, misalignedCalls: 0 };
	let state = acp.createInitialState();
	const core = acp.createCore();
	const assertCtx: string[] = [];

	const extension = {
		name: "acp-v1-probe",
		factory: (pi: unknown) => {
			(pi as { on: (e: string, h: (ev: never, ctx: never) => unknown) => void }).on(
				"context",
				(
					event: { messages: AgentMessageLike[] },
					ctx: {
						sessionManager: {
							buildContextEntries: () => Array<{ type: string; id: string; message?: AgentMessageLike; content?: unknown }>;
						};
						getContextUsage: () => { tokens: number | null; contextWindow: number } | undefined;
						model?: { contextWindow?: number };
						getSystemPrompt: () => string;
					},
				) => {
					stats.contextCalls++;
					const entries = ctx.sessionManager.buildContextEntries();
					if (entries.length === 0) assertCtx.push("entries-empty");
					const coreMessages = entriesToCoreMessages(entries);
					const { originals, aligned } = alignOriginals(entries, event.messages);
					if (aligned) stats.alignedCalls++;
					else stats.misalignedCalls++;
					const usage = ctx.getContextUsage();
					const systemTokens = ctx.getSystemPrompt ? acp.defaultCountTokens(ctx.getSystemPrompt()) : 0;
					const estimated =
						coreMessages.reduce((sum, m) => sum + acp.defaultCountTokens(m.text ?? ""), 0) + systemTokens;
					const tokenCount = usage?.tokens ?? estimated;
					const limit = ctx.model?.contextWindow ?? 256000;
					const config = acp.defaultConfig(limit);
					const t0 = performance.now();
					const turn = core.processTurn({ messages: coreMessages, state, config, tokenCount });
					const ms = performance.now() - t0;
					stats.turnMsMax = Math.max(stats.turnMsMax, ms);
					state = turn.state;
					stats.refs = Object.keys(state.messageRefs.byRaw).length;
					void saveState(sessionFileRef.current, state);
					const rebuilt = coreOutToAgentMessages(turn.messages, originals);
					return { messages: rebuilt };
				},
			);
			(pi as { on: (e: string, h: (ev: never) => unknown) => void }).on("session_start", () => undefined);
		},
	};
	const sessionFileRef: { current: string | undefined } = { current: undefined };

	const sm = await makeSession(runtime, "deepseek/deepseek-v4-flash", [extension], undefined);
	sessionFileRef.current = sm.sessionFile;
	try {
		// 两轮 prompt：第一轮读文件产生大上下文，验证 refs 分配 + 端到端管道
		await sm.session.prompt(
			`读取 ${join(cwd, "package-lock.json")} 的前 500 行，然后用一句话总结这个 lockfile 的规模。不要做其他事。`,
		);
		await sm.session.prompt("刚才读的文件大约有多少个依赖？只回答数字级别的估计。");
		// state 落盘验证
		if (!sm.sessionFile) throw new Error("V1: sessionFile missing");
		const raw = await readFile(`${sm.sessionFile}.acp.json`, "utf8");
		const persisted = JSON.parse(raw) as acp.CompressionState;
		if (!Array.isArray(persisted.blocks) || !persisted.messageRefs) {
			throw new Error("V1: persisted state malformed");
		}
		if (Object.keys(persisted.messageRefs.byRaw).length === 0) {
			throw new Error("V1: messageRefs empty after 2 prompts");
		}
	} finally {
		await sm.cleanup();
	}
	if (stats.contextCalls < 2) throw new Error(`V1: context hook called ${stats.contextCalls} times (< 2)`);
	if (stats.refs === 0) throw new Error("V1: state.messageRefs empty");
	if (assertCtx.includes("entries-empty")) throw new Error("V1: buildContextEntries returned empty at some point");
	console.log(
		`[V1] contextCalls=${stats.contextCalls} refs=${stats.refs} turnMsMax=${stats.turnMsMax.toFixed(1)} aligned=${stats.alignedCalls} misaligned=${stats.misalignedCalls}`,
	);
	console.log("[V1] processTurn 端到端 OK（消息转换无损、state 落盘、会话正常继续）");
}

// ---------- V3：模型听从度 ----------

async function phaseV3(runtime: InstanceType<typeof ModelRuntime>, modelSpecs: string[]) {
	const results: Array<{ model: string; compressCalls: number; assistantTurnsAfterNudge: number; ok: boolean }> = [];

	for (const spec of modelSpecs) {
		let state = acp.createInitialState();
		const core = acp.createCore();
		let compressCalls = 0;
		const nudgeLog: string[] = [];
		let nudgeInjectedAt = -1;
		let assistantEnds = 0;
		let assistantEndsSinceNudge = 0;
		// 阈值临时调低（fake limit 30k → 35% ≈ 10.5k tokens 即触发压力带），加速冒烟
		const FAKE_LIMIT = 30000;
		const config = acp.defaultConfig(FAKE_LIMIT, {
			nudge: { maxContextLimitPct: 0.35, emergencyThresholdPct: 2 },
			truncate: { threshold: 2 },
		});

		const extension = {
			name: "acp-v3-probe",
			factory: (pi: unknown) => {
				(pi as { on: (e: string, h: (ev: never, ctx: never) => unknown) => void }).on(
					"context",
					(
						event: { messages: AgentMessageLike[] },
						ctx: {
							sessionManager: {
								buildContextEntries: () => Array<{ type: string; id: string; message?: AgentMessageLike; content?: unknown }>;
								getSessionId: () => string;
							};
							getContextUsage: () => { tokens: number | null } | undefined;
							getSystemPrompt: () => string;
						},
					) => {
						const entries = ctx.sessionManager.buildContextEntries();
						const coreMessages = entriesToCoreMessages(entries);
						const { originals } = alignOriginals(entries, event.messages);
						const usage = ctx.getContextUsage();
						const systemTokens = ctx.getSystemPrompt ? acp.defaultCountTokens(ctx.getSystemPrompt()) : 0;
						const estimated =
							coreMessages.reduce((sum, m) => sum + acp.defaultCountTokens(m.text ?? ""), 0) + systemTokens;
						const tokenCount = usage?.tokens ?? estimated;
						const turn = core.processTurn({ messages: coreMessages, state, config, tokenCount });
						state = turn.state;
						const rebuilt = coreOutToAgentMessages(turn.messages, originals);
						if (turn.nudge?.shouldInject) {
							const viable = acp.viableRanges(turn.nudge.compressibleRanges);
							const rendered = acp.renderNudgeText(turn.nudge);
							const top = [...viable].sort((a, b) => b.tokens - a.tokens)[0];
							const example = top
								? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })`
								: "";
							const lines = [rendered.text];
							const active = state.blocks.filter((b) => b.active);
							if (active.length > 0) {
								lines.push("", `Compressed blocks: ${active.length} active — ${active.map((b) => b.blockId).join(", ")}.`);
							}
							lines.push(
								"",
								"Compressible ranges:",
								acp.formatRanges(viable, turn.nudge.protectedRanges ?? []),
								example,
							);
							if (nudgeInjectedAt < 0) nudgeInjectedAt = assistantEnds;
							nudgeLog.push(
								`usage=${Math.round(turn.nudge.contextUsage * 100)}% viable=${viable.length} emergency=${turn.nudge.breakdown?.emergencyOverride === 1}`,
							);
							// per-turn 去重：同一 turn 只注一次（冒烟简化：始终注入记录，模型行为可见即可）
							rebuilt.push({
								role: "user",
								content: lines.join("\n"),
								timestamp: Date.now(),
							} as AgentMessageLike);
						}
						return { messages: rebuilt };
					},
				);
				const api = pi as {
					on: (e: string, h: (ev: { message?: { role?: string } }) => void) => void;
					registerTool: (tool: unknown) => void;
				};
				api.on("message_end", (event) => {
					if (event.message?.role === "assistant") {
						assistantEnds++;
						if (nudgeInjectedAt >= 0) assistantEndsSinceNudge++;
					}
				});
				api.registerTool({
					name: "compress",
					label: "Compress",
					description: acp.COMPRESS_TOOL.description,
					parameters: {
						type: "object",
						properties: {
							content: {
								type: "array",
								items: {
									type: "object",
									properties: {
										startId: { type: "string" },
										endId: { type: "string" },
										summary: { type: "string" },
										topic: { type: "string" },
									},
									required: ["startId", "endId", "summary"],
								},
							},
						},
						required: ["content"],
					},
					async execute(toolCallId: string, params: { content: unknown }) {
						compressCalls++;
						const ranges = acp.parseCompressInput(params);
						return {
							content: [
								{
									type: "text",
									text: `[Compressed ${ranges.map((r) => `${r.startRef}-${r.endRef}`).join(", ")} → ${ranges.length} block(s), ~8000 tokens saved.]`,
								},
							],
						};
					},
				});
				// 只读三件套（模型可能先探查再压）
				api.registerTool({
					name: "acp_status",
					label: "ACP status",
					description: acp.ACP_STATUS_TOOL.description,
					parameters: { type: "object", properties: {} },
					async execute() {
						return { content: [{ type: "text", text: "context usage 40%; no blocks; compressible: m00002-m00040" }] };
					},
				});
			},
		};

		const sm = await makeSession(runtime, spec, [extension], undefined);
		const hardTimeout = setTimeout(() => {
			console.log(`[V3] ${spec}: hard timeout (300s) — abort`);
			try {
				sm.session.abort();
			} catch {
				/* already idle */
			}
		}, 300_000);
		try {
			// 第 1 轮：制造高占用（读大文件）
			console.log(`[V3] ${spec}: round 0 (read big file)...`);
			await sm.session.prompt(
				`读取 ${join(cwd, "package-lock.json")} 的前 800 行并总结依赖结构。不要压缩，先完成总结。除此之外不要做任何其他事。`,
			);
			// 后续轮：等待模型响应 nudge 调 compress（预算 3 轮 assistant 输出）
			const budget = 240_000;
			const t0 = Date.now();
			let round = 0;
			while (
				compressCalls === 0 &&
				assistantEndsSinceNudge < 3 &&
				Date.now() - t0 < budget
			) {
				round++;
				console.log(
					`[V3] ${spec}: round ${round} (compress=${compressCalls} assistantSinceNudge=${assistantEndsSinceNudge})...`,
				);
				await sm.session.prompt(
					round === 1
						? "很好。检查你的上下文占用情况，按照系统提醒的指引处理上下文（如果收到相关提醒）。不要做其他事。"
						: "继续。你的上下文可能已经过载——按提醒行事，处理完继续当前任务：把依赖总结再精炼一遍。不要做其他事。",
				);
			}
		} finally {
			clearTimeout(hardTimeout);
			await sm.cleanup();
		}
		const ok = compressCalls >= 1;
		results.push({ model: spec, compressCalls, assistantTurnsAfterNudge: assistantEndsSinceNudge, ok });
		console.log(
			`[V3] ${spec}: compressCalls=${compressCalls} assistantTurnsAfterNudge=${assistantEndsSinceNudge} nudges=[${nudgeLog.slice(0, 3).join(" | ")}] => ${ok ? "听从" : "未听从"}`,
		);
	}

	const anyOk = results.some((r) => r.ok);
	console.log(`[V3] summary: ${results.map((r) => `${r.model}=${r.ok ? "PASS" : "FAIL"}`).join(", ")}`);
	if (!anyOk) {
		throw new Error("V3: 所有模型 3 轮内 compress 调用均为 0 —— 停下回 channel（spec D2 需要紧急 fallback 评估）");
	}
}

// ---------- V1R：真实模块端到端（makeAcpExtension 直连会话） ----------

async function phaseV1R(runtime: InstanceType<typeof ModelRuntime>) {
	const { makeAcpExtension } = await import("../packages/backend/src/tools/acp-context/index.ts");
	const { acpStateFile } = await import("../packages/backend/src/tools/acp-context/index.ts");
	let enabledFlag = false;
	const memStore = {
		load: async () => (await import("acp-kernel")).createInitialState(),
		save: async () => {},
		reset: async () => {},
	};
	const sessionFileRef: { current: string | undefined } = { current: undefined };

	// 1) 开关关：零副作用（无工具注册、context 放行）
	const offExt = makeAcpExtension({ agentDir, isEnabled: () => false, store: memStore as never });
	const offPi: { tools: string[]; handlers: Map<string, Array<(e: never, c: never) => unknown>> } = {
		tools: [],
		handlers: new Map(),
	};
	(offExt as { factory: (pi: unknown) => void }).factory({
		on: (event: string, handler: (e: never, c: never) => unknown) => {
			const list = offPi.handlers.get(event) ?? [];
			list.push(handler);
			offPi.handlers.set(event, list);
		},
		registerTool: (tool: { name: string }) => offPi.tools.push(tool.name),
	});
	const offStart = offPi.handlers.get("session_start")?.[0];
	if (!offStart) throw new Error("V1R: session_start handler missing");
	await offStart({ type: "session_start", reason: "new" } as never, {
		sessionManager: { getSessionFile: () => null, getSessionId: () => "s1", buildContextEntries: () => [] },
	} as never);
	if (offPi.tools.length !== 0) throw new Error(`V1R: 开关关时注册了工具 ${offPi.tools.join(",")}`);

	// 2) 开关开：完整 context 管道 + 工具注册 + state 落盘（真实 store）
	enabledFlag = true;
	// 不注入 store：走真实 fileStore（store.ts 的 tmp+rename + version 字段全链路验证）
	const ext = makeAcpExtension({ agentDir, isEnabled: () => enabledFlag });
	const sm = await makeSession(runtime, "deepseek/deepseek-v4-flash", [ext], undefined);
	sessionFileRef.current = sm.sessionFile;
	let refsCount = 0;
	sm.session.subscribe((e: { type: string }) => {
		if (["message_end", "tool_execution_start", "agent_end", "agent_settled"].includes(e.type)) {
			console.log("[V1R event]", e.type);
		}
	});
	try {
		await sm.session.prompt(
			`读取 ${join(cwd, "package-lock.json")} 的前 300 行并一句话总结。除此之外什么都不要做。`,
		);
		// 校验要在 cleanup（删 tempRoot）之前做
		if (!sm.sessionFile) throw new Error("V1R: no sessionFile");
		const { readFile: rf } = await import("node:fs/promises");
		const statePath = acpStateFile(sm.sessionFile);
		if (!statePath) throw new Error("V1R: statePath null");
		const raw = await rf(statePath, "utf8");
		const persisted = JSON.parse(raw) as { version?: number; messageRefs?: { byRaw?: Record<string, string> } };
		if (persisted.version !== 1) throw new Error("V1R: state version != 1");
		refsCount = Object.keys(persisted.messageRefs?.byRaw ?? {}).length;
	} finally {
		await sm.cleanup();
	}
	if (refsCount === 0) throw new Error("V1R: messageRefs empty — context 管道没跑或没落盘");
	console.log(`[V1R] 真实模块 OK：关态零副作用；开态 refs=${refsCount} state 落盘（真实 fileStore）`);
}

// ---------- main ----------

async function main() {
	const phase = process.argv[2] ?? "all";
	if (phase === "v6") {
		assertV6();
		return;
	}
	const runtime = await setup();
	try {
		if (phase === "v2") await phaseV2(runtime);
		else if (phase === "v1") await phaseV1(runtime);
		else if (phase === "v3") {
			const specs = process.argv.slice(3);
			await phaseV3(runtime, specs.length > 0 ? specs : ["kimi-coding/k3", "deepseek/deepseek-v4-flash"]);
		} else if (phase === "v1r") {
			await phaseV1R(runtime);
		} else if (phase === "all") {
			assertV6();
			await phaseV2(runtime);
			await phaseV1(runtime);
			await phaseV1R(runtime);
			await phaseV3(runtime, ["kimi-coding/k3", "deepseek/deepseek-v4-flash"]);
		} else {
			throw new Error(`unknown phase: ${phase}`);
		}
		console.log("\nSMOKE ACP: ALL GREEN");
	} finally {
		// ModelRuntime 无显式 dispose；进程退出即释放
	}
}

await main();
// 冒烟是短生命周期 CLI：LLM 连接池等进程级句柄不随 dispose 释放，显式退出
process.exit(0);
