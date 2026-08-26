import { describe, expect, it } from "vitest";
import { makeEvapExtension } from "../src/tools/context-evaporation/extension";
import type { EvapBatchInfo, EvapConfig } from "../src/tools/context-evaporation/types";
import { DEFAULT_EVAP_CONFIG } from "../src/tools/context-evaporation/types";

/** 假 pi：记录 handler（照 acp-extension.test.ts 模式） */
function makeFakePi() {
	const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	return {
		handlers,
		on(event: string, handler: (event: never, ctx: never) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: { name: string }) {
			throw new Error(`evaporation 不应注册工具，收到 ${tool.name}`);
		},
		async emit(event: { type: string }, ctx: unknown) {
			const list = handlers.get(event.type) ?? [];
			let last: unknown;
			for (const handler of list) last = await (handler as (e: unknown, c: unknown) => unknown)(event, ctx);
			return last;
		},
	};
}

interface FakeCtxOptions {
	usage?: { tokens: number | null } | undefined;
	usageThrows?: boolean;
	contextWindow?: number;
}

function makeFakeCtx(options: FakeCtxOptions = {}) {
	return {
		sessionManager: {
			getSessionFile: () => null,
			getSessionId: () => "test-session",
			buildContextEntries: () => [],
		},
		getContextUsage: () => {
			if (options.usageThrows) throw new Error("usage boom");
			return options.usage ?? undefined;
		},
		model: { contextWindow: options.contextWindow ?? 256000 },
	};
}

/** 测试配置：小窗口便于触发水位 */
const TEST_CONFIG: EvapConfig = {
	...DEFAULT_EVAP_CONFIG,
	budgetTokens: 4000,
	protectionTokens: 100,
};

/** 典型 wire：read 结果（蒸发目标，~180 token）+ 大块用户文本尾巴（~80 token，
 * 把 read 结果顶出 protectionTokens=100 的尾部保护区） */
function makeWire(): Array<Record<string, unknown>> {
	const readLines = (n: number) =>
		Array.from({ length: n }, (_, i) => `${String(i).padStart(4, "0")} ${"a".repeat(30)}`).join("\n");
	return [
		{ role: "user", content: "请读取文件", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/tmp/a.ts" } }],
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: readLines(20) }],
			isError: false,
			timestamp: 1,
		},
		{ role: "user", content: `后续说明。${"这是背景补充。".repeat(15)}`, timestamp: 2 },
	];
}

function firstText(messages: Array<Record<string, unknown>>, index: number): string {
	const msg = messages[index] as { content?: Array<{ type: string; text?: string }> } | undefined;
	const content = msg?.content;
	if (!Array.isArray(content)) return "";
	const first = content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

async function wire(options: {
	enabled: boolean;
	config?: EvapConfig;
	reporter?: (b: EvapBatchInfo) => void;
}) {
	const pi = makeFakePi();
	const extension = makeEvapExtension({
		agentDir: "/tmp/agent",
		isEnabled: () => options.enabled,
		getConfig: () => options.config ?? TEST_CONFIG,
		reporter: options.reporter,
	});
	(extension as { factory: (pi: unknown) => void }).factory(pi);
	return pi;
}

async function emitContext(
	pi: Awaited<ReturnType<typeof wire>>,
	messages: Array<Record<string, unknown>>,
	ctxOptions: FakeCtxOptions = {},
): Promise<{ messages?: Array<Record<string, unknown>> } | undefined> {
	return (await pi.emit({ type: "context", messages } as never, makeFakeCtx(ctxOptions))) as
		| { messages?: Array<Record<string, unknown>> }
		| undefined;
}

describe("开关矩阵", () => {
	it("开关关：session_start 零动作，context 原样放行（undefined，wire 不变）", async () => {
		const pi = await wire({ enabled: false });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const result = await emitContext(pi, makeWire(), { usage: { tokens: 3900 } });
		expect(result).toBeUndefined();
	});

	it("开关开：session_start 正常完成且不注册任何工具（零 prompt 污染形态）", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "resume" }, makeFakeCtx());
		// makeFakePi.registerTool 会 throw——走到这里即未注册
	});

	it("Tier 0（低水位）：返回 undefined（原样放行，零干扰）", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const result = await emitContext(pi, makeWire(), { usage: { tokens: 100 } });
		expect(result).toBeUndefined();
	});

	it("高水位：wire 被蒸发（read 结果 → stub），返回新数组", async () => {
		const batches: Array<{ sessionId: string; batch: EvapBatchInfo }> = [];
		const pi = await wire({
			enabled: true,
			reporter: (sessionId, b) => batches.push({ sessionId, batch: b }),
		});
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const wire0 = makeWire();
		// usage 3900 / min(256000, 4000) = 97.5% ≥ 85% → Tier 2
		const result = await emitContext(pi, wire0, { usage: { tokens: 3900 } });
		expect(result?.messages).toBeTruthy();
		expect(result?.messages).not.toBe(wire0);
		expect(firstText(result?.messages ?? [], 2)).toContain("输出已淘汰");
		// 未蒸发消息保持对象身份（user 原对象）
		expect(result?.messages?.[0]).toBe(wire0[0]);
		// 批次上报（有动作才报；sessionId 来自 session_start 会话闭窗——trace 按会话落盘的 key）
		expect(batches.length).toBe(1);
		expect(batches[0]?.batch.pruned).toBeGreaterThan(0);
		expect(batches[0]?.sessionId).toBe("test-session");
	});
});

describe("水位口径（窗口分母陷阱，plan §7-5）", () => {
	it("分母 = min(contextWindow, budgetTokens)：1M 模型上钉回 256K 预算", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		// 1M 窗口 + budget 4000：3900 token = 97.5%（预算口径）而非 0.39%（窗口口径）→ 蒸发
		const result = await emitContext(pi, makeWire(), {
			usage: { tokens: 3900 },
			contextWindow: 1000000,
		});
		expect(result?.messages).toBeTruthy();
		expect(firstText(result?.messages ?? [], 2)).toContain("输出已淘汰");
	});

	it("小窗口模型：min() 取 contextWindow（128K 模型 + 256K budget → 128K 分母）", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		// 128000 窗口 + budget 4000 → 分母 4000；10 token = 0.25% → Tier 0
		const result = await emitContext(pi, makeWire(), {
			usage: { tokens: 10 },
			contextWindow: 128000,
		});
		expect(result).toBeUndefined();
	});

	it("usage.tokens = null（compaction 后首轮）→ 内部估算兜底", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		// wire 实际估算 ~500 token / 4000 = ~12.5% → Tier 0 放行（估算路径本身可达）
		const result = await emitContext(pi, makeWire(), { usage: { tokens: null } });
		expect(result).toBeUndefined();
	});

	it("getContextUsage 抛异常 → usageTokens=null 兜底，不 throw", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const result = await emitContext(pi, makeWire(), { usageThrows: true });
		expect(result).toBeUndefined();
	});
});

describe("决策生命周期", () => {
	it("session_compact 重置决策：重置后同水位不再带旧 stub（Tier 0 放行验证 Map 已清）", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		// 高水位 → stub 产生决策
		await emitContext(pi, makeWire(), { usage: { tokens: 3900 } });
		// 低水位：决策仍在（stub 字节复用，返回新数组）
		const kept = await emitContext(pi, makeWire(), { usage: { tokens: 100 } });
		expect(kept?.messages).toBeTruthy();
		expect(firstText(kept?.messages ?? [], 2)).toContain("输出已淘汰");
		// compact → 重置
		await pi.emit({ type: "session_compact" }, makeFakeCtx());
		// 低水位：无决策 → 原样放行
		const after = await emitContext(pi, makeWire(), { usage: { tokens: 100 } });
		expect(after).toBeUndefined();
	});

	it("同进程开关 开→关→开：关时放行，决策 Map 保留（切回继续复用，KV 单调）", async () => {
		let enabled = true;
		const pi = makeFakePi();
		const extension = makeEvapExtension({
			agentDir: "/tmp",
			isEnabled: () => enabled,
			getConfig: () => TEST_CONFIG,
		});
		(extension as { factory: (pi: unknown) => void }).factory(pi);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());

		await emitContext(pi, makeWire(), { usage: { tokens: 3900 } });
		enabled = false;
		expect(await emitContext(pi, makeWire(), { usage: { tokens: 3900 } })).toBeUndefined();
		enabled = true;
		const back = await emitContext(pi, makeWire(), { usage: { tokens: 100 } });
		// 切回后低水位也保持 stub（决策未丢）
		expect(firstText(back?.messages ?? [], 2)).toContain("输出已淘汰");
	});

	it("session_start 任意 reason → 全新 Map（不残留上一会话决策）", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		await emitContext(pi, makeWire(), { usage: { tokens: 3900 } });
		// 模拟 reload/fork：session_start 重发
		await pi.emit({ type: "session_start", reason: "reload" }, makeFakeCtx());
		const after = await emitContext(pi, makeWire(), { usage: { tokens: 100 } });
		expect(after).toBeUndefined(); // 决策已清
	});
});

describe("context 钩子契约（绝不 throw）", () => {
	it("内部异常（getConfig 抛）→ 返回 undefined 原样放行", async () => {
		const pi = makeFakePi();
		const extension = makeEvapExtension({
			agentDir: "/tmp",
			isEnabled: () => true,
			getConfig: () => {
				throw new Error("config boom");
			},
		});
		(extension as { factory: (pi: unknown) => void }).factory(pi);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const result = await emitContext(pi, makeWire(), { usage: { tokens: 3900 } });
		expect(result).toBeUndefined();
	});

	it("非法 wire 形态（未知 role / 空消息）不抛、不蒸发", async () => {
		const pi = await wire({ enabled: true });
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const weird: Array<Record<string, unknown>> = [
			{ role: "custom", customType: "todo-reminder", content: "x", display: false },
			{ role: "bashExecution", command: "ls", output: "y", exitCode: 0, cancelled: false, truncated: false },
			{ role: "user", content: null },
			{ role: "toolResult", content: "not-an-array" },
		];
		const result = await emitContext(pi, weird, { usage: { tokens: 3900 } });
		// 全部不可蒸发 → 无决策 → 原样放行
		expect(result).toBeUndefined();
	});
});
