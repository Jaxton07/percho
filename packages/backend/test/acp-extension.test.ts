import { createInitialState } from "acp-kernel";
import { describe, expect, it } from "vitest";
import type { BridgeEntry } from "../src/tools/acp-context/bridge";
import { type AcpStore, makeAcpExtension } from "../src/tools/acp-context/extension";

/** 假 pi：记录 handler 与工具注册 */
function makeFakePi() {
	const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	const tools: Array<{ name: string }> = [];
	return {
		handlers,
		tools,
		on(event: string, handler: (event: never, ctx: never) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool);
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
	sessionFile?: string;
	entries?: BridgeEntry[];
	usage?: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	usageThrows?: boolean;
	systemPrompt?: string;
}

function makeFakeCtx(options: FakeCtxOptions = {}) {
	return {
		sessionManager: {
			getSessionFile: () => options.sessionFile ?? null,
			getSessionId: () => "test-session",
			buildContextEntries: () => options.entries ?? [],
		},
		getContextUsage: () => {
			if (options.usageThrows) throw new Error("boom");
			return options.usage;
		},
		getSystemPrompt: () => options.systemPrompt ?? "system prompt",
		model: { contextWindow: 256000 },
	};
}

function makeMemoryStore() {
	const saved: unknown[] = [];
	let resetCount = 0;
	const store: AcpStore = {
		load: async () => createInitialState(),
		save: async (_f, s) => {
			saved.push(s);
		},
		reset: async () => {
			resetCount++;
		},
	};
	return { store, saved, resetCount: () => resetCount };
}

async function wire(isEnabled: boolean) {
	const pi = makeFakePi();
	const mem = makeMemoryStore();
	const extension = makeAcpExtension({
		agentDir: "/tmp/agent",
		isEnabled: () => isEnabled,
		store: mem.store,
	});
	(extension as { factory: (pi: unknown) => void }).factory(pi);
	return { pi, mem };
}

/** 压缩段 ≥3 条消息（kernel 推荐节点按 user 边界分段的段内最少条数约束） */
const bigEntries: BridgeEntry[] = [
	{ type: "message", id: "e1", message: { role: "user", content: "x".repeat(6000), timestamp: 1 } },
	{
		type: "message",
		id: "e2",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }],
			timestamp: 1,
		},
	},
	{
		type: "message",
		id: "e3",
		message: {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "y".repeat(6000) }],
			timestamp: 1,
		},
	},
	{ type: "message", id: "e4", message: { role: "user", content: "follow up", timestamp: 2 } },
];

describe("开关矩阵", () => {
	it("开关关：session_start 后零副作用（不注册工具、context 放行、不 cancel）", async () => {
		const { pi } = await wire(false);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		expect(pi.tools).toHaveLength(0);
		const contextResult = await pi.emit(
			{ type: "context", messages: [] } as never,
			makeFakeCtx({ entries: bigEntries }),
		);
		expect(contextResult).toBeUndefined();
		const compactResult = await pi.emit(
			{ type: "session_before_compact", reason: "threshold" } as never,
			makeFakeCtx({ usage: { tokens: 100000, contextWindow: 256000, percent: 40 } }),
		);
		expect(compactResult).toBeUndefined();
	});

	it("开关开：session_start 注册 4 工具 + system prompt 追加 ACP 段", async () => {
		const { pi } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		expect(pi.tools.map((t) => t.name).sort()).toEqual([
			"acp_status",
			"compress",
			"decompress",
			"search_context",
		]);
		const promptResult = (await pi.emit(
			{
				type: "before_agent_start",
				prompt: "hi",
				systemPrompt: "BASE PROMPT",
			} as never,
			makeFakeCtx(),
		)) as { systemPrompt?: string };
		expect(promptResult?.systemPrompt).toContain("BASE PROMPT");
		expect(promptResult?.systemPrompt).toContain("ACP context management");
		expect(promptResult?.systemPrompt).toContain("Compression Philosophy:");
	});
});

describe("session_before_compact cancel 矩阵（spec D2 + 紧急 fallback）", () => {
	it("threshold + 占用 < 90% → cancel（ACP 接管）", async () => {
		const { pi } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const result = await pi.emit(
			{ type: "session_before_compact", reason: "threshold" } as never,
			makeFakeCtx({ usage: { tokens: 100000, contextWindow: 256000, percent: 40 } }),
		);
		expect(result).toEqual({ cancel: true });
	});

	it("threshold + 占用 ≥ 90% → 不 cancel（SDK 硬着陆兜底）", async () => {
		const { pi } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const result = await pi.emit(
			{ type: "session_before_compact", reason: "threshold" } as never,
			makeFakeCtx({ usage: { tokens: 240000, contextWindow: 256000, percent: 93.75 } }),
		);
		expect(result).toBeUndefined();
	});

	it("threshold + usage percent 未知（null）→ 仍 cancel（ACP 活跃路径）", async () => {
		const { pi } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const result = await pi.emit(
			{ type: "session_before_compact", reason: "threshold" } as never,
			makeFakeCtx({ usage: { tokens: null, contextWindow: 256000, percent: null } }),
		);
		expect(result).toEqual({ cancel: true });
	});

	it("overflow / manual → 不 cancel（保 SDK 兜底与用户意图）", async () => {
		const { pi } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		for (const reason of ["overflow", "manual"] as const) {
			const result = await pi.emit(
				{ type: "session_before_compact", reason } as never,
				makeFakeCtx({ usage: { tokens: 100000, contextWindow: 256000, percent: 40 } }),
			);
			expect(result).toBeUndefined();
		}
	});

	it("getContextUsage 抛异常 → 保守不 cancel", async () => {
		const { pi } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const result = await pi.emit(
			{ type: "session_before_compact", reason: "threshold" } as never,
			makeFakeCtx({ usageThrows: true }),
		);
		expect(result).toBeUndefined();
	});
});

describe("session_compact 重置", () => {
	it("重置内存 state + 删旁路文件 + 清 nudge 去重", async () => {
		const { pi, mem } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		// 先跑一次 context 产生 nudge 去重记录与 state 落盘
		const ctx = makeFakeCtx({
			entries: bigEntries,
			usage: { tokens: 240000, contextWindow: 256000, percent: 94 },
		});
		const first = (await pi.emit({ type: "context", messages: [] } as never, ctx)) as
			| { messages?: Array<{ role: string; content?: unknown }> }
			| undefined;
		expect(first?.messages).toBeTruthy();
		expect(mem.saved.length).toBeGreaterThan(0);

		await pi.emit({ type: "session_compact", compactionEntry: {} } as never, makeFakeCtx());
		expect(mem.resetCount()).toBe(1);
	});
});

describe("context 钩子契约（绝不 throw）", () => {
	it("内部异常（buildContextEntries 抛）→ 返回 undefined 原样放行", async () => {
		const { pi } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const badCtx = {
			...makeFakeCtx(),
			sessionManager: {
				getSessionFile: () => null,
				getSessionId: () => "s",
				buildContextEntries: () => {
					throw new Error("entries boom");
				},
			},
		};
		const result = await pi.emit({ type: "context", messages: [] } as never, badCtx);
		expect(result).toBeUndefined();
	});

	it("session_start 加载失败 → 降级关闭（context 放行、无工具）", async () => {
		const pi = makeFakePi();
		const badStore: AcpStore = {
			load: async () => {
				throw new Error("store boom");
			},
			save: async () => {},
			reset: async () => {},
		};
		const extension = makeAcpExtension({ agentDir: "/tmp", isEnabled: () => true, store: badStore });
		(extension as { factory: (pi: unknown) => void }).factory(pi);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		expect(pi.tools).toHaveLength(0);
		const result = await pi.emit(
			{ type: "context", messages: [] } as never,
			makeFakeCtx({ entries: bigEntries }),
		);
		expect(result).toBeUndefined();
	});
});

describe("R3：同进程开关 开→关 后工具 execute 拒绝", () => {
	it("关后调 compress 报 disabled 错误（SDK 无 unregisterTool 的兜底）", async () => {
		const pi = makeFakePi();
		let enabledFlag = true;
		const mem = makeMemoryStore();
		const extension = makeAcpExtension({
			agentDir: "/tmp/agent",
			isEnabled: () => enabledFlag,
			store: mem.store,
		});
		(extension as { factory: (pi: unknown) => void }).factory(pi);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		expect(pi.tools.length).toBe(4); // 开时已注册

		enabledFlag = false; // 同进程关闭（session_start 不会重发）
		const compress = pi.tools.find((t) => t.name === "compress");
		if (!compress) throw new Error("compress tool missing");
		await expect(
			(compress as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("c1", {
				content: [{ startId: "m00001", endId: "m00002", summary: "s".repeat(60) }],
			}),
		).rejects.toThrow("ACP compression is currently disabled");
	});
});

describe("context 管道行为", () => {
	it("高占用：注入 nudge（user 消息在数组末尾）+ 消息带 <acp> 标签；同 turn 去重", async () => {
		const { pi } = await wire(true);
		await pi.emit({ type: "session_start", reason: "new" }, makeFakeCtx());
		const ctx = makeFakeCtx({
			entries: bigEntries,
			usage: { tokens: 240000, contextWindow: 256000, percent: 94 },
		});
		const eventMessages = [
			{ role: "user", content: "x".repeat(6000), timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				content: [{ type: "text", text: "y".repeat(6000) }],
				timestamp: 1,
			},
			{ role: "user", content: "follow up", timestamp: 2 },
		];
		const first = (await pi.emit({ type: "context", messages: eventMessages } as never, ctx)) as {
			messages?: Array<{ role: string; content?: unknown }>;
		};
		// nudge 注入在末尾
		const last = first?.messages?.[first.messages.length - 1];
		expect(last?.role).toBe("user");
		expect(String(last?.content)).toMatch(/compress/i);
		// 标签注入（模型可见坐标系）
		const serialized = JSON.stringify(first?.messages);
		expect(serialized).toMatch(/<acp tokens=/);

		// 同一 turn（turnKey 相同，entries 未变）第二次 context → nudge 去重
		const second = (await pi.emit({ type: "context", messages: eventMessages } as never, ctx)) as {
			messages?: Array<{ role: string; content?: unknown }>;
		};
		const last2 = second?.messages?.[second.messages.length - 1];
		// 末尾不再是 nudge（是原最后一条 user 消息 + 标签）
		expect(String(last2?.content)).not.toMatch(/context usage/i);
	});
});
