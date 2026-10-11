import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	boundMessages,
	degradeLayer1,
	exactEstimate,
	protectionStart,
	TURN_START_ROLES,
} from "../src/tools/compaction-guard/bound";
import { hardCapTokens } from "../src/tools/compaction-guard/guard";
import type { GuardMessage } from "../src/tools/compaction-guard/types";

/**
 * 有界化核心验收（spec §6 A1 / A3 / A6③），全部零 SDK 依赖，除了：
 * - A3 用**真实事故会话**（跑真 SDK 的 prepareCompaction + serializeConversation）；
 * - A6③ 读 SDK dist 源码里 `isTurnStartMessage` 的分支表，钉住我们复刻的轮起点规则。
 */

/**
 * SDK dist 目录：vitest（vite-node）里 `import.meta.resolve` 不可用，所以从本文件的 `import.meta.url` 反推
 * （packages/backend/test/ → 仓库根 /node_modules/…）。
 */
const SDK_DIST_DIR = fileURLToPath(
	new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/", import.meta.url),
);

/** 测试用序列化器：与 SDK 的形状无关，只要求「可比较」 */
const serialize = (messages: GuardMessage[]): string =>
	messages
		.map((message) => {
			const content = message.content;
			if (typeof content === "string") return `${message.role}:${content}`;
			return `${message.role}:${content
				.map((block) => {
					if (typeof block.text === "string") return block.text;
					if (typeof block.thinking === "string") return block.thinking;
					if (block.type === "toolCall") return JSON.stringify(block.arguments ?? {});
					return `<${block.type}>`;
				})
				.join("|")}`;
		})
		.join("\n\n");

/** 一轮：user → assistant(thinking + toolCall) → toolResult */
function turn(
	index: number,
	sizes: { thinking: number; toolResult: number; argBody: number },
): GuardMessage[] {
	const toolCallId = `call-${index}`;
	return [
		{ role: "user", content: [{ type: "text", text: `问题-${index}` }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `思考-${index}-${"思".repeat(sizes.thinking)}` },
				{ type: "text", text: `回答-${index}` },
				{
					type: "toolCall",
					id: toolCallId,
					name: "write",
					arguments: { path: `/tmp/f${index}.md`, content: "z".repeat(sizes.argBody) },
				},
				{ type: "image", data: `img-${index}`, mimeType: "image/png" },
			],
		} as GuardMessage,
		{
			role: "toolResult",
			toolCallId,
			toolName: "write",
			content: [
				{
					type: "text",
					text: `HEAD-${index}\n${"行".repeat(40)}\nMIDDLE-${index}-${"x".repeat(sizes.toolResult)}\nTAIL-${index}`,
				},
			],
		} as GuardMessage,
	];
}

const history = (turns: number, sizes = { thinking: 200, toolResult: 2000, argBody: 500 }): GuardMessage[] =>
	Array.from({ length: turns }, (_, i) => turn(i + 1, sizes)).flat();

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("A1 层 1 降级：保护区外降级、保护区内与正文原样、输入零改动", () => {
	const messages = history(4);
	const snapshot = clone(messages);
	const result = boundMessages(messages, {
		cap: Number.POSITIVE_INFINITY, // 只测层 1（cap 不介入时应当完全不改）
		protectTurns: 2,
		toolResultChars: 300,
		serialize,
	});

	it("cap 不介入（<=0 / 非有限）时原样返回", () => {
		expect(result.messages).toBe(messages);
		expect(result.stats.withinCap).toBe(true);
	});

	it("真正的层 1：保护区外三条降级规则都生效", () => {
		const degraded = boundMessages(messages, {
			cap: 100_000,
			protectTurns: 2,
			toolResultChars: 300,
			serialize,
		});
		const out = degraded.messages;
		// 保护区起点 = 第 3 轮的 user（最近 2 轮）
		expect(protectionStart(messages, 2)).toBe(6);

		// ① 思考 → 占位（第 1 轮）
		const thinking1 = (out[1].content as { type: string; thinking?: string }[])[0];
		expect(thinking1.thinking).toMatch(/^\[思考已省略 \d+ 字符\]$/);
		// ② toolCall 参数 → 白名单（只留 path，正文消失）
		const call1 = (out[1].content as { type: string; arguments?: Record<string, unknown> }[])[2];
		expect(call1.arguments?.path).toBe("/tmp/f1.md");
		expect(call1.arguments?.content).toBeUndefined();
		expect(String(call1.arguments?._omitted)).toContain("已省略");
		// ③ toolResult → 头/尾保留、中段消失、带省略标记
		const toolText1 = (out[2].content as { text?: string }[])[0].text ?? "";
		expect(toolText1).toContain("HEAD-1");
		expect(toolText1).not.toContain("x".repeat(300));
		expect(toolText1).toContain("已省略");
		expect(toolText1.length).toBeLessThanOrEqual(300);
		// 图片等其它 block 原样
		const image1 = (out[1].content as { type: string }[])[3];
		expect(image1.type).toBe("image");

		// 保护区内（第 3、4 轮）原样：对象引用都不变
		expect(out[6]).toBe(messages[6]);
		expect(out[11]).toBe(messages[11]);
		const thinking3 = (out[7].content as { thinking?: string }[])[0];
		expect(thinking3.thinking).toContain("思".repeat(200));
		// user / assistant 正文原样
		expect(out[0]).toBe(messages[0]);
		expect((out[1].content as { text?: string }[])[1].text).toBe("回答-1");

		// 输入绝不被就地改（SDK 的 preparation 与默认摘要路径共享引用）
		expect(messages).toEqual(snapshot);
		// 新数组 + 改动过的消息是新对象
		expect(out).not.toBe(messages);
		expect(out[1]).not.toBe(messages[1]);
		expect(degraded.stats.degradedMessages).toBeGreaterThan(0);
		expect(degraded.stats.estimatedAfter).toBeLessThan(degraded.stats.estimatedBefore);
	});
});

describe("层 2 硬上限：整体估算口径收敛 + 省略标记 + 单条超限交回 SDK", () => {
	it("cap 很小 → 从最旧丢到整体估算 ≤ cap，并插一行省略标记", () => {
		const messages = history(6);
		const cap = 400;
		const result = boundMessages(messages, { cap, protectTurns: 2, toolResultChars: 300, serialize });
		expect(result.stats.measure).toBe("exact");
		expect(result.stats.droppedMessages).toBeGreaterThan(0);
		expect(result.stats.withinCap).toBe(true);
		expect(exactEstimate(result.messages, serialize)).toBeLessThanOrEqual(cap);
		// 插了省略标记（作为最旧一条 user 消息）
		expect(JSON.stringify(result.messages[0].content)).toContain("条消息已省略");
		// 丢掉的是最旧的那些（第 1 轮的内容不见了）
		expect(serialize(result.messages)).not.toContain("问题-1");
	});

	it("保护区内单条本身就超 cap 且丢不动 → 对它二次收紧（保护区让位）", () => {
		// 极端构造：只剩一条（丢不动了）且它在保护区内，而它自己就超 cap。
		// 若不动它，整份输入只能原样退回 SDK（等于这块会话永远无界），所以这一步允许越过保护区。
		const messages: GuardMessage[] = [
			{ role: "toolResult", content: [{ type: "text", text: "x".repeat(4000) }] },
		];
		const cap = 100;
		const result = boundMessages(messages, { cap, protectTurns: 2, toolResultChars: 300, serialize });
		expect(result.stats.withinCap).toBe(true);
		expect(result.stats.oversizedMessages).toBe(0);
		expect(result.stats.degradedMessages).toBe(1);
		expect(result.stats.droppedMessages).toBe(0);
		const huge = (result.messages[0].content as { text?: string }[])[0].text ?? "";
		expect(huge.length).toBeLessThan(200);
		expect(huge).toContain("已省略");
		expect(messages).toEqual(clone(messages)); // 入参零改动
	});

	it("M2：二次收紧时纯文本块（user 长文档）也被截，且只截「自身就超 cap」的那几条", () => {
		// 直接测规则本身（越过 cap 机制的干扰）：strict 只对 strictIndices 指定的那几条生效
		const messages: GuardMessage[] = [
			{ role: "user", content: [{ type: "text", text: `长文档-${"y".repeat(5000)}` }] },
			{ role: "user", content: [{ type: "text", text: "短问题" }] },
		];
		const strict = degradeLayer1(messages, {
			protectTurns: 0,
			toolResultChars: 300,
			strict: true,
			strictIndices: [0],
		});
		const docText = (strict.messages[0].content as { text?: string }[])[0].text ?? "";
		expect(docText.length).toBeLessThanOrEqual(80); // OVERSIZED_TEXT_CHARS
		expect(docText).toContain("已省略");
		// 没被指定的那条（哪怕在保护区外）不动
		expect((strict.messages[1].content as { text?: string }[])[0].text).toBe("短问题");
		expect(strict.messages[1]).toBe(messages[1]);
		// 入参零改动
		expect(((messages[0].content as { text?: string }[])[0].text ?? "").length).toBeGreaterThan(5000);
	});

	it("M2 + 层 2 端到端：只剩一条纯文本消息时也能收敛到 cap 之内", () => {
		const messages: GuardMessage[] = [
			{ role: "user", content: [{ type: "text", text: `长文档-${"y".repeat(5000)}` }] },
		];
		const result = boundMessages(messages, { cap: 100, protectTurns: 2, toolResultChars: 300, serialize });
		expect(result.stats.withinCap).toBe(true);
		expect(result.stats.oversizedMessages).toBe(0);
		const text = (result.messages[0].content as { text?: string }[])[0].text ?? "";
		expect(text.length).toBeLessThanOrEqual(80);
		expect(text).toContain("已省略");
	});

	it("M1：怎么都收不下去时交回**已知最小的那一版**（不是原样）", () => {
		// 第 2 条是**字符串 content**（不在任何降级规则里）⇒ 它永远超 cap；
		// 第 1 条能收紧，收紧后仍超限 ⇒ 交回的必须是「收紧过的那一版」
		const messages: GuardMessage[] = [
			{ role: "user", content: [{ type: "text", text: `长文档-${"y".repeat(20_000)}` }] },
			{ role: "assistant", content: "y".repeat(20_000) },
		];
		const cap = 100;
		const result = boundMessages(messages, { cap, protectTurns: 0, toolResultChars: 300, serialize });
		expect(result.stats.withinCap).toBe(false); // 残余风险照实上报
		expect(result.stats.oversizedMessages).toBe(1); // 就那条收不下去的
		expect(result.messages).not.toBe(messages); // M1：不返回原样
		const docText = (result.messages[0].content as { text?: string }[])[0].text ?? "";
		expect(docText.length).toBeLessThanOrEqual(80); // 能收紧的都收紧了才交回
		expect(result.stats.degradedMessages).toBe(1);
		// 入参仍然零改动
		expect(((messages[0].content as { text?: string }[])[0].text ?? "").length).toBeGreaterThan(20_000);
		expect(messages[1].content).toHaveLength(20_000);
	});

	it("cap <= 0 / NaN → 不介入（极端小窗口）", () => {
		const messages = history(2);
		for (const cap of [0, -1, Number.NaN]) {
			const result = boundMessages(messages, { cap, protectTurns: 2, toolResultChars: 300, serialize });
			expect(result.messages).toBe(messages);
			expect(result.stats.withinCap).toBe(true);
			expect(result.stats.droppedMessages).toBe(0);
		}
	});
});

describe("hardCapTokens（spec D3 公式）", () => {
	it("1M 窗口：min(0.5 × 窗口, 窗口 − summaryMaxOut − 2048)", () => {
		expect(
			hardCapTokens({
				contextWindow: 1_000_000,
				reserveTokens: 16_384,
				maxTokens: 32_000,
				hardCapRatio: 0.5,
			}),
		).toBe(500_000);
	});

	it("200k 窗口：比例项与「窗口 − 输出 − 余量」项取小", () => {
		expect(
			hardCapTokens({ contextWindow: 200_000, reserveTokens: 16_384, maxTokens: 32_000, hardCapRatio: 0.5 }),
		).toBe(100_000);
	});

	it("小窗口：不夹紧到绝对下限（可能得到 ≤ 0 ⇒ 不介入）", () => {
		// 20k 窗口 + 16k reserve：比例项 10000、窗口项 20000 − 13107 − 2048 = 4845 ⇒ 取小
		expect(
			hardCapTokens({ contextWindow: 20_000, reserveTokens: 16_384, maxTokens: 32_000, hardCapRatio: 0.5 }),
		).toBe(4845);
		// 14k 窗口时窗口项变成负数 ⇒ 结果为负（不会被夹到 65536）⇒ 上层判定「不介入」
		const negative = hardCapTokens({
			contextWindow: 14_000,
			reserveTokens: 16_384,
			maxTokens: 32_000,
			hardCapRatio: 0.5,
		});
		expect(negative).toBeLessThan(0);
		expect(
			hardCapTokens({ contextWindow: 0, reserveTokens: 16_384, maxTokens: 32_000, hardCapRatio: 0.5 }),
		).toBe(0);
	});

	it("maxTokens 缺失/<=0 时按「无单独输出上限」处理", () => {
		expect(hardCapTokens({ contextWindow: 1_000_000, reserveTokens: 16_384, hardCapRatio: 0.5 })).toBe(
			500_000,
		);
	});
});

describe("A6③ 轮起点规则与 SDK 口径一致（SDK 升级后红了就是提醒复核）", () => {
	it("复刻的分支表 == SDK `isTurnStartMessage` 源码里的分支表", () => {
		const source = readFileSync(join(SDK_DIST_DIR, "core/compaction/compaction.js"), "utf8");
		const start = source.indexOf("function isTurnStartMessage");
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, start + 600);
		const trueBlock = body.slice(body.indexOf("case"), body.indexOf("return true"));
		const trueRoles = [...trueBlock.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);
		expect(trueRoles.length).toBeGreaterThan(0);
		expect([...trueRoles].sort()).toEqual([...TURN_START_ROLES].sort());
	});
});

// ---------- A3：真实事故会话离线重放 ----------

const ACCIDENT_SESSION = join(
	homedir(),
	".pi/agent/sessions/--Users-ericw-work-code-ZhongWei-project-pi-runtime-core--/2026-10-11T03-45-33-947Z_01a12910-defb-738a-9c4d-4294452e9ac5.jsonl",
);
/** 提供商实测上限（spec §1.3）：A3 要求另断言 ≤ 它的 50% */
const PROVIDER_LIMIT_TOKENS = 994_387;

async function sdkCompactionBits() {
	const mod = (await import(pathToFileURL(join(SDK_DIST_DIR, "core/compaction/index.js")).href)) as {
		prepareCompaction: (
			entries: unknown[],
			settings: unknown,
		) =>
			| { messagesToSummarize: GuardMessage[]; turnPrefixMessages: GuardMessage[]; isSplitTurn: boolean }
			| undefined;
		serializeConversation: (messages: unknown[]) => string;
	};
	const messages = (await import(pathToFileURL(join(SDK_DIST_DIR, "core/messages.js")).href)) as {
		convertToLlm: (messages: unknown[]) => unknown[];
	};
	return {
		prepareCompaction: mod.prepareCompaction,
		serialize: (list: GuardMessage[]) => mod.serializeConversation(messages.convertToLlm(list)),
	};
}

describe("A3 事故会话离线重放：整体估算 ≤ hardCap（两档窗口）", () => {
	it.skipIf(!existsSync(ACCIDENT_SESSION))(
		"1M 与 200k 两档窗口都收敛在 cap 之内（200k 那档同时是层 2 的收敛验证）",
		{ timeout: 120_000 },
		async () => {
			const { prepareCompaction, serialize } = await sdkCompactionBits();
			const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
			const session = SessionManager.open(ACCIDENT_SESSION);
			const preparation = prepareCompaction(session.getBranch(), settings);
			expect(preparation).toBeDefined();
			const historyInput = preparation?.messagesToSummarize ?? [];
			const prefixInput = preparation?.turnPrefixMessages ?? [];
			expect(historyInput.length).toBeGreaterThan(1000);

			for (const contextWindow of [1_000_000, 200_000]) {
				const cap = hardCapTokens({
					contextWindow,
					reserveTokens: settings.reserveTokens,
					maxTokens: 32_000,
					hardCapRatio: 0.5,
				});
				expect(cap).toBe(contextWindow === 1_000_000 ? 500_000 : 100_000);

				for (const [label, input] of [
					["history", historyInput],
					["turn-prefix", prefixInput],
				] as const) {
					if (input.length === 0) continue;
					const result = boundMessages(input, { cap, protectTurns: 2, toolResultChars: 300, serialize });
					const whole = exactEstimate(result.messages, serialize);
					expect(result.stats.withinCap, `${contextWindow}/${label}`).toBe(true);
					expect(whole, `${contextWindow}/${label} 整体估算 ≤ cap`).toBeLessThanOrEqual(cap);
					if (contextWindow === 1_000_000) {
						expect(whole, `${label} ≤ 提供商上限 50%`).toBeLessThanOrEqual(PROVIDER_LIMIT_TOKENS * 0.5);
					}
					if (contextWindow === 200_000 && label === "history") {
						// 层 2 必须真的介入（这档窗口下仅靠降级到不了 cap）
						expect(result.stats.measure).toBe("exact");
						expect(result.stats.droppedMessages).toBeGreaterThan(0);
					}
				}
			}
		},
	);
});
