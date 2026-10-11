import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../src/tools/compaction-guard/estimate";
import { makeCompactionGuardExtension } from "../src/tools/compaction-guard/extension";
import { hardCapTokens } from "../src/tools/compaction-guard/guard";
import type { CompactionGuardObservation } from "../src/tools/compaction-guard/types";

/**
 * 扩展接线验收（spec §6 A4 / A5 / A6①②）：用**真实 AgentSession + 自造 streamFn**
 * （仿 `compaction-image.test.ts` 的 `makeStreamFn`）跑通「压缩 → 钩子 → 有界化 → SDK 默认摘要器」全链路，
 * 断言**捕获到的摘要请求**真的变小。
 *
 * 造历史的约定（便于逐轮断言，`i` = 轮序号）：
 * - 思考正文含 `THINKING-BODY-SECRET-i`；toolResult 中段含 `TOOLRESULT-MIDDLE-i-xxxx…`（头 5 行 / 尾 3 行保留、中段会被截）。
 * - 所以：**降级轮**的 `THINKING-BODY-SECRET-i` 与 `TOOLRESULT-MIDDLE-i` 必须消失；**保护区内**轮则原样保留。
 */

const ROOTS: string[] = [];
afterEach(() => {
	for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MODEL = (contextWindow: number, maxTokens = 2048) => ({
	id: "fake-model",
	name: "fake-model",
	api: "openai-completions" as const,
	provider: "fake",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow,
	maxTokens,
});

interface Step {
	text?: string;
	stopReason?: string;
	errorMessage?: string;
	usageInput?: number;
}

interface Capture {
	system: string;
	user: string;
	summarization: boolean;
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const b = block as { type?: string; text?: string; thinking?: string; arguments?: unknown };
			if (typeof b.text === "string") return b.text;
			if (typeof b.thinking === "string") return b.thinking;
			return b.type === "toolCall" ? JSON.stringify(b.arguments ?? {}) : "";
		})
		.join("\n");
};

/** 假 streamFn：既能被 agent 循环消费（async iterable），也能被摘要器 `.result()` 消费 */
function makeFakeStream(step: Step | ((callIndex: number) => Step)) {
	const captures: Capture[] = [];
	let callIndex = 0;
	const fn = async (_model: unknown, context: { messages: { role: string; content: unknown }[] }) => {
		const system = context.messages
			.filter((m) => m.role === "system")
			.map((m) => textOf(m.content))
			.join("\n");
		const user = context.messages
			.filter((m) => m.role !== "system")
			.map((m) => textOf(m.content))
			.join("\n");
		const current = typeof step === "function" ? step(callIndex) : step;
		callIndex++;
		captures.push({ system, user, summarization: system.includes("context summarization assistant") });
		const input = current.usageInput ?? 10;
		const message = {
			role: "assistant",
			content: [{ type: "text", text: current.text ?? "ok" }],
			stopReason: current.stopReason ?? "stop",
			errorMessage: current.errorMessage,
			usage: {
				input,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
			provider: "fake",
			model: "fake-model",
		};
		return {
			async *[Symbol.asyncIterator]() {
				// 不流式：由 result() 收尾（agent 循环会走 `await result()` 分支）
			},
			result: async () => message,
		};
	};
	return { fn, captures };
}

interface SetupOptions {
	contextWindow?: number;
	maxTokens?: number;
	/** settings.json 的 compaction 段（SDK 设置：enabled / reserveTokens / keepRecentTokens） */
	sdkCompaction?: Record<string, unknown>;
	/** settings.json 的 compactionGuard 段（本扩展配置） */
	guard?: Record<string, unknown>;
	/** 预置历史 */
	history?: (session: Appendable) => void;
	/** 假 stream 的脚本 */
	stream?: Step | ((callIndex: number) => Step);
}

async function setup(options: SetupOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "percho-guard-ext-"));
	ROOTS.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	// keepRecentTokens 给小值：测试历史也能有切点（否则 prepareCompaction 判 too small）
	const settings: Record<string, unknown> = {
		compaction: { keepRecentTokens: 2000, ...(options.sdkCompaction ?? {}) },
	};
	if (options.guard) settings.compactionGuard = options.guard;
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	// 假 provider 必须注册进 models.json 且在 auth.json 里有凭证：
	// `session.prompt()` 先查 `hasConfiguredAuth(provider)`（models.json 的 provider 列表 + 凭证存储）
	writeFileSync(
		join(agentDir, "auth.json"),
		`${JSON.stringify({ fake: { type: "api_key", key: "test-key" } })}\n`,
	);
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					fake: {
						name: "Fake",
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						models: [
							{
								id: "fake-model",
								reasoning: false,
								contextWindow: options.contextWindow ?? 20_000,
								maxTokens: options.maxTokens ?? 2048,
								input: ["text"],
							},
						],
					},
				},
			},
			null,
			2,
		)}\n`,
	);

	const observations: CompactionGuardObservation[] = [];
	const extension = makeCompactionGuardExtension({
		agentDir,
		reporter: (_sessionId, observation) => {
			observations.push(observation);
		},
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [extension],
	});
	await resourceLoader.reload(); // 工厂要在 createAgentSession 前装载（同 builtin-extensions.test.ts）
	const model = MODEL(options.contextWindow ?? 20_000, options.maxTokens ?? 2048);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: "off",
		noTools: "all",
		sessionManager: SessionManager.create(cwd, join(root, "sessions")),
		settingsManager: SettingsManager.create(cwd, agentDir),
		resourceLoader,
	});
	const stream = makeFakeStream(options.stream ?? { text: "ok" });
	session.agent.streamFunction = stream.fn;
	options.history?.(session as unknown as Appendable);
	const cap = hardCapTokens({
		contextWindow: model.contextWindow,
		reserveTokens: (options.sdkCompaction?.reserveTokens as number | undefined) ?? 16_384,
		maxTokens: model.maxTokens,
		hardCapRatio: (options.guard?.hardCapRatio as number | undefined) ?? 0.5,
	});
	return { session, captures: stream.captures, observations, cap, agentDir };
}

// ---------- 造假历史 ----------

const SECRET_THINKING = "THINKING-BODY-SECRET";
const SECRET_MIDDLE = "TOOLRESULT-MIDDLE";

interface Appendable {
	sessionManager: { appendMessage: (message: unknown) => string };
}

/** 一轮：user → assistant(thinking + 带正文的 toolCall) → toolResult（中段是长正文，会被层 1 截掉） */
function appendTurn(
	session: Appendable,
	index: number,
	sizes: { thinking: number; toolResult: number },
): void {
	const toolCallId = `call-${index}`;
	const now = Date.now();
	session.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: `用户提问 ${index}` }],
		timestamp: now,
	});
	session.sessionManager.appendMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `${SECRET_THINKING}-${index} ${"思".repeat(sizes.thinking)}` },
			{ type: "text", text: `我先看看第 ${index} 轮` },
			{
				type: "toolCall",
				id: toolCallId,
				name: "read",
				arguments: { path: `/tmp/file-${index}.ts`, offset: 0, limit: 100 },
			},
		],
		stopReason: "toolUse",
		timestamp: now,
		provider: "fake",
		model: "fake-model",
	});
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		isError: false,
		content: [
			{
				type: "text",
				text: `HEAD-${index}\nline2-${index}\nline3-${index}\nline4-${index}\nline5-${index}\n${SECRET_MIDDLE}-${index}-${"x".repeat(sizes.toolResult)}\nTAIL1-${index}\nTAIL2-${index}\nTAIL3-${index}`,
			},
		],
		timestamp: now,
	});
}

/** 标准 8 轮历史：约 1.3 万 token，keepRecentTokens=2000 时 `messagesToSummarize` 里至少 3–4 轮在保护区外 */
const bigHistory =
	(turns = 8) =>
	(session: Appendable) => {
		for (let i = 1; i <= turns; i++) appendTurn(session, i, { thinking: 600, toolResult: 3000 });
	};

const summarizationPrompts = (captures: Capture[]): string =>
	captures
		.filter((c) => c.summarization)
		.map((c) => c.user)
		.join("\n---\n");

describe("A4 / A6① 摘要请求真的变小（思考正文消失 · toolResult 中段截掉 · 整体估算 ≤ cap）", () => {
	it("手动 compact()：保护区外降级，摘要器读到的是替换后的内容", async () => {
		const { session, captures, observations, cap } = await setup({
			contextWindow: 20_000,
			sdkCompaction: { reserveTokens: 2000 },
			history: bigHistory(),
		});
		try {
			expect(cap).toBe(10_000); // min(0.5×20000, 20000 − 1600 − 2048)
			await session.compact();
			const prompt = summarizationPrompts(captures);
			expect(prompt.length).toBeGreaterThan(0);

			const bound = observations.find((o) => o.phase === "bound");
			expect(bound).toMatchObject({ reason: "manual", measure: "cheap" });
			expect(bound?.degradedMessages ?? 0).toBeGreaterThan(0);
			expect(bound?.estimatedAfter ?? Number.POSITIVE_INFINITY).toBeLessThan(bound?.estimatedBefore ?? 0);

			// A6①：钩子替换 messagesToSummarize 后，SDK 默认摘要器读到的就是替换后的内容
			expect(prompt).toContain("[思考已省略"); // 老轮思考 → 占位
			expect(prompt).not.toContain(`${SECRET_THINKING}-1`); // 第 1 轮思考正文消失
			expect(prompt).toContain("…（已省略"); // toolResult 被截并标注
			expect(prompt).not.toContain(`${SECRET_MIDDLE}-1-`); // 第 1 轮 toolResult 中段消失
			expect(prompt).toMatch(new RegExp(`${SECRET_MIDDLE}-\\d+-x`)); // 保护区内某轮原样保留
			expect(prompt).not.toContain("x".repeat(2000)); // 没有任何一条 toolResult 还带着完整长正文
			expect(estimateTokens(prompt)).toBeLessThanOrEqual(cap); // A4：整个摘要请求落在 cap 之内
		} finally {
			session.dispose();
		}
	});
});

describe("A4 层 2：总量仍超上限时从最旧整条丢（整体估算口径收敛）", () => {
	it("cap 很小 → 丢老消息 + 插省略标记，整体估算 ≤ cap", async () => {
		const { session, captures, observations, cap } = await setup({
			contextWindow: 10_000,
			sdkCompaction: { reserveTokens: 2000 },
			guard: { hardCapRatio: 0.1 }, // cap = min(1000, 10000 − 1600 − 2048) = 1000
			history: bigHistory(),
		});
		try {
			expect(cap).toBe(1000);
			await session.compact();
			const prompt = summarizationPrompts(captures);
			const bound = observations.find((o) => o.phase === "bound");
			expect(bound?.measure).toBe("exact");
			expect(bound?.droppedMessages ?? 0).toBeGreaterThan(0);
			expect(bound?.estimatedAfter ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(cap);
			expect(prompt).toContain("条消息已省略"); // 插了省略标记
			// 摘要模板自身 ~1.6k 字符（≈650 tokens）不参与 cap，断言时留这层余量
			expect(estimateTokens(prompt)).toBeLessThanOrEqual(cap + 1500);
		} finally {
			session.dispose();
		}
	});
});

describe("A5 三条触发路径都过钩子（reason 可见）", () => {
	it("① 手动 compact()（reason=manual）", async () => {
		const { session, observations, captures } = await setup({
			sdkCompaction: { reserveTokens: 2000 },
			guard: { thresholdPct: 100 }, // 让自研触发闭嘴，只留手动
			history: bigHistory(),
		});
		try {
			await session.compact();
			expect(observations.some((o) => o.phase === "bound" && o.reason === "manual")).toBe(true);
			expect(summarizationPrompts(captures)).toContain("[思考已省略");
		} finally {
			session.dispose();
		}
	});

	it("② SDK 阈值路径（reason=threshold）", async () => {
		const { session, observations } = await setup({
			contextWindow: 20_000,
			sdkCompaction: { enabled: true, reserveTokens: 2000 },
			guard: { thresholdPct: 100 }, // 避免与自研触发混淆
			stream: { text: "ok", usageInput: 19_000 }, // 19k > 20k − 2k ⇒ shouldCompact
			history: bigHistory(),
		});
		try {
			await session.prompt("再问一句");
			const bound = observations.find((o) => o.phase === "bound");
			expect(bound?.reason).toBe("threshold");
			expect(bound?.degradedMessages ?? 0).toBeGreaterThan(0);
		} finally {
			session.dispose();
		}
	});

	it("③ 溢出恢复路径（reason=overflow）", async () => {
		const { session, observations, captures } = await setup({
			sdkCompaction: { enabled: true, reserveTokens: 2000 },
			guard: { thresholdPct: 100 },
			stream: (callIndex) =>
				callIndex === 0
					? {
							text: "",
							stopReason: "error",
							errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
							usageInput: 19_000,
						}
					: { text: "重试成功", usageInput: 100 },
			history: bigHistory(),
		});
		try {
			await session.prompt("再问一句");
			expect(observations.some((o) => o.phase === "bound" && o.reason === "overflow")).toBe(true);
			expect(summarizationPrompts(captures)).toContain("[思考已省略");
		} finally {
			session.dispose();
		}
	});
});

describe("A6②（修订）compaction.enabled=false：SDK 全自动路径（含溢出恢复）都关掉，自研触发仍可用", () => {
	/**
	 * 事实（SDK 1.0.4 代码）：`_checkCompaction()` 第一件事就是 `if (!settings.enabled) return false;`
	 * （`agent-session.js:2325-2328`），而溢出恢复（`:2377` / `:2403`）和其余自动阈值入口
	 * （`_compactBeforeNextAssistantResponse` :429、虚拟模型路由 :480）都在其内部或由 `shouldCompact()` 门控
	 * ⇒ **enabled=false 时 SDK 不做任何自动压缩**（spec §2 依赖②的原话与代码不符，已记 IMPL-NOTES）。
	 * 对本机制的含义：此时唯一能压缩的路径就是自研 `ctx.compact()`（手动入口不看 enabled）——
	 * 所以这个用例断言的是「溢出不再自动恢复 + 自研触发照样把输入有界化」。
	 *
	 * 另一条被这里证实的事实：error 终止的 assistant 消息**不参与 usage 口径**
	 * （`getAssistantUsage()` 会跳过 aborted/error），此时 `getContextUsage().tokens` 退回纯估算，
	 * 所以 percent 可能低于真实用量 —— 本用例用 40% 阈值让触发成立，并断言 `percentBasis = "estimate"`。
	 */
	it("溢出错误不再自动压缩；agent_settled 的自研触发仍压缩且有界", async () => {
		const { session, observations } = await setup({
			contextWindow: 20_000,
			sdkCompaction: { enabled: false, reserveTokens: 2000 },
			guard: { thresholdPct: 40 }, // 估算口径 ≈9k/20k ≈ 45% ⇒ 触发
			stream: (callIndex) =>
				callIndex === 0
					? {
							text: "",
							stopReason: "error",
							errorMessage: "Your input exceeds the context window of this model",
							usageInput: 19_000,
						}
					: { text: "重试成功", usageInput: 100 },
			history: bigHistory(),
		});
		try {
			await session.prompt("再问一句");
			// SDK 未走溢出恢复（enabled=false 的门在 _checkCompaction 开头）
			expect(observations.some((o) => o.reason === "overflow")).toBe(false);
			// 自研触发（95% ≥ 80%）压缩，且输入被有界化
			const bound = observations.find((o) => o.phase === "bound");
			expect(bound?.source).toBe("guard");
			expect(bound?.degradedMessages ?? 0).toBeGreaterThan(0);
			const trigger = observations.find((o) => o.phase === "trigger");
			expect(trigger?.reason).toBe("threshold-pct");
			expect(trigger?.percentBasis).toBe("estimate"); // error 轮的 usage 不算数 ⇒ 纯估算口径
		} finally {
			session.dispose();
		}
	});
});
