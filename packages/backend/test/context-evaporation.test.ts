import { describe, expect, it } from "vitest";
import { estTokens } from "../src/tools/context-evaporation/estimate";
import { evaporateWire, IMAGE_STUB_TEXT, inspectParts } from "../src/tools/context-evaporation/evaporate";
import {
	createEvapState,
	DEFAULT_EVAP_CONFIG,
	type EvapConfig,
	type EvapState,
	type EvapWireMessage,
} from "../src/tools/context-evaporation/types";

// ---------- 测试脚手架 ----------

function userText(text: string): EvapWireMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function userBlocks(content: unknown[]): EvapWireMessage {
	return { role: "user", content, timestamp: 1 };
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown> = {}): EvapWireMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	};
}

function toolResult(
	id: string,
	name: string,
	text: string,
	opts: { isError?: boolean; images?: string[]; details?: unknown } = {},
): EvapWireMessage {
	const content: unknown[] = [{ type: "text", text }];
	for (const img of opts.images ?? []) {
		content.push({ type: "image", data: img, mimeType: "image/png" });
	}
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content,
		isError: opts.isError === true,
		details: opts.details,
	};
}

function readLines(n: number, width = 25): string {
	return Array.from({ length: n }, (_, i) => `${String(i).padStart(4, "0")} ${"a".repeat(width)}`).join("\n");
}

/** 不可蒸发配重：纯用户文本（红线），垫在 wire 头部把水位顶进高压区 */
function ballast(tokens: number): EvapWireMessage {
	return userText(`背景说明。${"背景资料。".repeat(Math.max(1, Math.ceil(tokens / 8)))}`);
}

const TEST_CONFIG: EvapConfig = {
	...DEFAULT_EVAP_CONFIG,
	protectionTokens: 200,
};

/** 全量估算 token（选择测试窗口用，与核心内部同口径） */
function totalTokens(wire: EvapWireMessage[], config = TEST_CONFIG): number {
	return inspectParts(wire, createEvapState(), config).reduce((s, v) => s + v.tFull, 0);
}

function windowFor(wire: EvapWireMessage[], pct: number, config = TEST_CONFIG): number {
	return Math.round(totalTokens(wire, config) / (pct / 100));
}

function evap(
	wire: EvapWireMessage[],
	state: EvapState,
	windowTokens: number,
	usageTokens: number | null = null,
	config = TEST_CONFIG,
) {
	return evaporateWire(wire, state, config, { windowTokens, usageTokens });
}

/** 典型 wire：read 结果（蒸发目标）+ 尾部内容（把目标推出保护区） */
function typicalWire(): EvapWireMessage[] {
	return [
		userText("请读取文件"),
		assistantToolCall("c1", "read", { path: "/tmp/a.ts" }),
		toolResult("c1", "read", readLines(40)),
		userText("现在跑个命令看看"),
		assistantToolCall("c2", "bash", { command: "ls -la" }),
		toolResult("c2", "bash", readLines(20, 50)),
	];
}

function resultText(wire: EvapWireMessage[], index: number): string {
	const content = wire[index]?.content;
	if (!Array.isArray(content)) return "";
	const first = content[0] as { type?: string; text?: string };
	return first?.type === "text" ? (first.text ?? "") : "";
}

// ---------- 估算器 ----------

describe("estTokens", () => {
	it("中文 ≈ 1.7 token/字，ASCII ≈ 1 token/4 字符", () => {
		expect(estTokens("一二三")).toBe(Math.ceil(3 * 1.7));
		expect(estTokens("abcd")).toBe(1);
		expect(estTokens("")).toBe(0);
	});
});

// ---------- Tier 1：每层规则 ----------

describe("Tier 1 snip 规则", () => {
	it("read：头 10 行 + 标记 + 尾 5 行（逐字符锁定）", () => {
		const wire = typicalWire();
		const state = createEvapState();
		const w = windowFor(wire, 70); // 60% ≤ pct < 85% → Tier 1
		const { messages, batch } = evap(wire, state, w);
		expect(batch.tier).toBe(1);
		const text = resultText(messages, 2);
		const lines = readLines(40).split("\n");
		const head10 = lines.slice(0, 10).join("\n");
		const tail5 = lines.slice(-5).join("\n");
		expect(text).toBe(`${head10}\n…（已截断 25 行，共 40 行，需要时可用相同参数重读）\n${tail5}`);
		// 未蒸发消息保持对象身份；数组为新数组
		expect(messages[0]).toBe(wire[0]);
		expect(messages).not.toBe(wire);
	});

	it("bash（>4096B）：头 15 行 + 标记 + 尾 25 行", () => {
		const bigBash = readLines(100, 50); // 100 行 × ~55 字符 ≈ 5.5KB
		const wire = [
			ballast(20000),
			userText("跑命令"),
			assistantToolCall("c1", "bash", { command: "npm run build" }),
			toolResult("c1", "bash", bigBash),
			userText("好的"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 70));
		const text = resultText(messages, 3);
		const lines = bigBash.split("\n");
		const head15 = lines.slice(0, 15).join("\n");
		const tail25 = lines.slice(-25).join("\n");
		expect(text).toBe(`${head15}\n…（已截断 60 行，共 100 行，完整输出可用相同命令重跑）\n${tail25}`);
	});

	it("bash ≤4096B 不截断（headTailThreshold）", () => {
		const smallBash = readLines(30, 50); // ≈1.6KB < 4096
		const wire = [
			userText("跑命令"),
			assistantToolCall("c1", "bash", {}),
			toolResult("c1", "bash", smallBash),
			userText("好的"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 70));
		expect(resultText(messages, 2)).toBe(smallBash);
	});

	it("用户代码块折叠：大块头 5 行 + 总行数标注，块外原文保留", () => {
		const block = Array.from({ length: 20 }, (_, i) => `line ${i} ${"b".repeat(40)}`).join("\n");
		const text = `看这个文件\n\`\`\`ts\n${block}\n\`\`\`\n帮我改`;
		const wire = [
			userText(text),
			assistantToolCall("c1", "read", { path: "/tmp/a.ts" }),
			toolResult("c1", "read", readLines(40)),
			userText("继续"),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 70));
		const out = messages[0] as { content: string };
		// fenced 块内容 = "ts" 语言行 + 20 行内容 + 尾空行（split("```")[1]），头 5 行保留
		const blockLines = `ts\n${block}\n`.split("\n");
		const expected =
			"看这个文件\n```" +
			`${blockLines.slice(0, 5).join("\n")}\n…（代码块已折叠，共 ${blockLines.length} 行）\n` +
			"```\n帮我改";
		expect(out.content).toBe(expected);
	});

	it("纯用户文本（无代码块）任何 Tier 不动（红线）", () => {
		const longText = "这是一段很长的用户意图说明。".repeat(100);
		const wire = [
			userText(longText),
			assistantToolCall("c1", "read", { path: "/tmp/a.ts" }),
			toolResult("c1", "read", readLines(40)),
			userText("继续"),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 99));
		expect(messages[0]).toBe(wire[0]);
	});

	it("toolCall 参数块与 thinking 不动", () => {
		const wire = typicalWire();
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 99));
		expect(messages[1]).toBe(wire[1]); // assistant toolCall 原对象
	});
});

// ---------- Tier 2：stub 格式 ----------

describe("Tier 2 stub 格式（三类模板逐字符锁定）", () => {
	it("read stub：淘汰标注 + 重读指令", () => {
		// 配重垫高水位：snip 批压不到 80% 下方，stub 才会执行（hysteresis 动力学）
		const wire = [ballast(20000), ...typicalWire()];
		const state = createEvapState();
		const { messages, batch } = evap(wire, state, windowFor(wire, 90));
		expect(batch.tier).toBe(2);
		const original = readLines(40);
		expect(resultText(messages, 3)).toBe(
			`[输出已淘汰：${(original.length / 1024).toFixed(1)}KB / 40 行。需要时用相同参数重读即可恢复]`,
		);
	});

	it("bash stub：尾 5 行原文 + 标记", () => {
		const bigBash = readLines(100, 50);
		const wire = [
			ballast(20000),
			userText("跑命令"),
			assistantToolCall("c1", "bash", { command: "npm run build" }),
			toolResult("c1", "bash", bigBash),
			userText("好的"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90));
		const tail5 = bigBash.split("\n").slice(-5).join("\n");
		expect(resultText(messages, 3)).toBe(
			`${tail5}\n[以上为尾部输出，完整 100 行 / ${(bigBash.length / 1024).toFixed(1)}KB 已淘汰，可用相同命令重跑获取]`,
		);
	});

	it("webfetch stub：标题/首行保留 + URL 提示", () => {
		const fetched = ["My Page Title", ...Array.from({ length: 50 }, (_, i) => `content ${i} xxxxx`)].join(
			"\n",
		);
		const wire = [
			ballast(20000),
			userText("抓页面"),
			assistantToolCall("c1", "webfetch", { url: "https://example.com" }),
			toolResult("c1", "webfetch", fetched),
			userText("好的"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90));
		expect(resultText(messages, 3)).toBe(
			`[输出已淘汰：${(fetched.length / 1024).toFixed(1)}KB。标题/首行：“My Page Title”。URL 见上方调用参数，可重新 fetch（内容可能已变化）]`,
		);
	});

	it("mcp 等其他 external：同 webfetch 形态但提示改为重新调用", () => {
		const fetched = ["result header", ...Array.from({ length: 50 }, (_, i) => `row ${i} yyyyy`)].join("\n");
		const wire = [
			ballast(20000),
			userText("查工具"),
			assistantToolCall("c1", "mcp", { tool: "search" }),
			toolResult("c1", "mcp", fetched),
			userText("好的"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90));
		expect(resultText(messages, 3)).toBe(
			`[输出已淘汰：${(fetched.length / 1024).toFixed(1)}KB。首行：“result header”。可用相同参数重新调用获取]`,
		);
	});

	it("edit/write：Tier 1 不动，Tier 2 大 diff 换尾 5 行 stub", () => {
		const bigDiff = Array.from({ length: 100 }, (_, i) => `+ changed line ${i} ${"z".repeat(40)}`).join("\n");
		const wire = [
			ballast(20000),
			userText("改文件"),
			assistantToolCall("c1", "edit", { path: "/tmp/a.ts" }),
			toolResult("c1", "edit", bigDiff),
			userText("好的"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state1 = createEvapState();
		expect(resultText(evap(wire, state1, windowFor(wire, 70)).messages, 3)).toBe(bigDiff);

		const state2 = createEvapState();
		const out = evap(wire, state2, windowFor(wire, 90));
		const tail5 = bigDiff.split("\n").slice(-5).join("\n");
		expect(resultText(out.messages, 3)).toBe(
			`${tail5}\n[以上为尾部输出，完整 100 行 / ${(bigDiff.length / 1024).toFixed(1)}KB 已淘汰，需要时可用相同参数重读文件]`,
		);
	});

	it("图片：Tier 2 原位换占位文本（toolResult 与 user 图片）", () => {
		const wire = [
			ballast(60000), // 配重远大于可蒸 savings，stub 批不会中途停机
			userBlocks([
				{ type: "text", text: "看这两张图" },
				{ type: "image", data: "userimgdata1", mimeType: "image/png" },
				{ type: "image", data: "userimgdata2", mimeType: "image/png" },
			]),
			assistantToolCall("c1", "bash", { command: "screencapture x.png" }),
			toolResult("c1", "bash", readLines(100, 50), { images: ["toolimgdata"] }),
			userText("继续"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90));
		const user = messages[1] as { content: Array<{ type: string; text?: string }> };
		expect(user.content[1]).toEqual({ type: "text", text: IMAGE_STUB_TEXT });
		expect(user.content[2]).toEqual({ type: "text", text: IMAGE_STUB_TEXT });
		expect(IMAGE_STUB_TEXT).toBe("[图片已淘汰，可用原方式重新获取]");
		const tr = messages[3] as { content: Array<{ type: string; text?: string }> };
		expect(tr.content.some((b) => b.type === "image")).toBe(false);
		expect(tr.content.some((b) => b.type === "text" && b.text === IMAGE_STUB_TEXT)).toBe(true);
	});
});

// ---------- 单调性与决策复用 ----------

describe("stub 决策单调持久化", () => {
	it("同一 part 两次计算字节相同；Tier 0 返回原数组身份、决策空", () => {
		const wire = typicalWire();
		const state = createEvapState();
		const r0 = evap(wire, state, windowFor(wire, 50));
		expect(r0.messages).toBe(wire); // 未跨线：原数组引用
		expect(state.decisions.size).toBe(0);

		const w = windowFor(wire, 70);
		const r1 = evap(wire, state, w);
		const r2 = evap(wire, state, w);
		expect(resultText(r1.messages, 3)).toBe(resultText(r2.messages, 3));
		expect(r2.batch.cacheHits).toBeGreaterThan(0); // 已决策复用
	});

	it("full→snip→stub 只升不降；水位回落后决策保持（KV cache 约束）", () => {
		const wire = [ballast(20000), ...typicalWire()];
		const state = createEvapState();
		const t1 = evap(wire, state, windowFor(wire, 70));
		expect(resultText(t1.messages, 3)).toContain("已截断");

		const t2 = evap(wire, state, windowFor(wire, 90));
		expect(resultText(t2.messages, 3)).toContain("输出已淘汰");

		// 水位跌回 Tier 0：决策仍生效（stub 字节不变）
		const t3 = evap(wire, state, windowFor(wire, 50));
		expect(t3.batch.tier).toBe(0);
		expect(resultText(t3.messages, 3)).toBe(resultText(t2.messages, 3));
	});

	it("已 stub 的 part 不因后续更高水位重算（字节稳定）", () => {
		const wire = [ballast(20000), ...typicalWire()];
		const state = createEvapState();
		evap(wire, state, windowFor(wire, 90));
		const again = evap(wire, state, windowFor(wire, 99));
		const text = resultText(again.messages, 3);
		expect(text).toContain("输出已淘汰");
		expect(again.batch.cacheHits).toBeGreaterThan(0);
	});
});

// ---------- 红线 ----------

describe("红线不可破", () => {
	it("保护区（尾部 protectionTokens）内的输出任何水位不动", () => {
		const wire = typicalWire();
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 99));
		// bash 结果是最后一条消息，恒与尾部保护区相交
		expect(resultText(messages, 5)).toBe(readLines(20, 50));
	});

	it("保护区按 token 不按条数：多个小输出累计覆盖窗口", () => {
		const small = readLines(6, 30); // 每个约 55 token
		const wire: EvapWireMessage[] = [
			userText("开始"),
			assistantToolCall("c0", "read", { path: "/tmp/a.ts" }),
			toolResult("c0", "read", readLines(40)),
		];
		for (let i = 1; i <= 6; i++) {
			wire.push(assistantToolCall(`s${i}`, "bash", { command: `echo ${i}` }));
			wire.push(toolResult(`s${i}`, "bash", small));
		}
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90));
		// 目标 read 结果被蒸发（snip）；最尾部小输出保持（最后一条恒与保护窗口相交）
		expect(resultText(messages, 2)).toContain("已截断");
		const last = messages[messages.length - 1];
		expect(last).toBe(wire[wire.length - 1]);
	});

	it("最近一次 isError 的 toolResult 保护区外也保持（调试现场）", () => {
		const wire = [
			userText("跑命令"),
			assistantToolCall("c1", "bash", { command: "npm test" }),
			toolResult("c1", "bash", readLines(100, 50), { isError: true }),
			userText("再读个文件"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
			userText("好的"),
			assistantToolCall("c3", "read", { path: "/tmp/c.ts" }),
			toolResult("c3", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90));
		expect(resultText(messages, 2)).toBe(readLines(100, 50)); // isError 保留
	});

	it("protectedTools（todo）输出不动", () => {
		const todoOut = Array.from({ length: 100 }, (_, i) => `- item ${i} pending`).join("\n");
		const wire = [
			userText("管理任务"),
			assistantToolCall("c1", "todo", {}),
			toolResult("c1", "todo", todoOut),
			userText("好的"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 99));
		expect(resultText(messages, 2)).toBe(todoOut);
	});

	it("compactionProtected 标记位钉住（v1 检查点）", () => {
		const wire = [
			userText("跑"),
			assistantToolCall("c1", "bash", { command: "x" }),
			toolResult("c1", "bash", readLines(100, 50), { details: { compactionProtected: true } }),
			userText("好的"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90));
		expect(resultText(messages, 2)).toBe(readLines(100, 50));
	});

	it("custom / bashExecution 等未知角色不碰不计", () => {
		const wire: EvapWireMessage[] = [
			{ role: "custom", customType: "todo-reminder", content: "remember", display: false },
			userText("读取"),
			assistantToolCall("c1", "read", { path: "/tmp/a.ts" }),
			toolResult("c1", "read", readLines(40)),
			userText("继续"),
		];
		const state = createEvapState();
		const total = totalTokens(wire);
		expect(inspectParts(wire, createEvapState(), TEST_CONFIG).some((v) => v.cls === "custom")).toBe(false);
		const { messages } = evap(wire, state, windowFor(wire, 90));
		expect(messages[0]).toBe(wire[0]);
		expect(total).toBeGreaterThan(0);
	});
});

// ---------- hysteresis 与 Tier 累积 ----------

describe("hysteresis（大跳，处理到触发线 −5%）", () => {
	it("Tier 1 触发后批量处理到 55% 下方停手，未跨线零动作", () => {
		const wire: EvapWireMessage[] = [userText("开始")];
		for (let i = 0; i < 10; i++) {
			wire.push(assistantToolCall(`c${i}`, "read", { path: `/tmp/f${i}.ts` }));
			wire.push(toolResult(`c${i}`, "read", readLines(40))); // 每个 tFull 250、tSnip ~124
		}
		wire.push(userText("结尾"));
		const state = createEvapState();
		// 70% 触发 → 处理到 55% 下方：总 ~2500+，需降到 <55% → 至少 snip 若干个
		const { batch } = evap(wire, state, windowFor(wire, 70));
		expect(batch.tier).toBe(1);
		expect(batch.snipped).toBeGreaterThan(0);
		expect(batch.usagePct).toBeGreaterThanOrEqual(60);
		expect(batch.usagePct).toBeLessThan(85);
		// 处理后应低于 60−5=55% 线（允许保护区内 part 无法继续的边界）
		const after = batch.wireEstTokens / windowFor(wire, 70);
		expect(after * 100).toBeLessThan(55.0001);
	});

	it("Tier 累积：85% 触发时先 T1 后 T2（read 直接升 stub，且用户代码块折叠）", () => {
		const block = Array.from({ length: 30 }, (_, i) => `code ${i} ${"z".repeat(50)}`).join("\n");
		const wire: EvapWireMessage[] = [
			ballast(20000),
			userBlocks([{ type: "text", text: `分析\n\`\`\`ts\n${block}\n\`\`\`` }]),
			assistantToolCall("c1", "read", { path: "/tmp/a.ts" }),
			toolResult("c1", "read", readLines(40)),
			userText("继续"),
			assistantToolCall("c2", "read", { path: "/tmp/b.ts" }),
			toolResult("c2", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages, batch } = evap(wire, state, windowFor(wire, 90));
		expect(batch.tier).toBe(2);
		expect(resultText(messages, 3)).toContain("输出已淘汰"); // T2 stub
		const user = messages[1] as { content: Array<{ type: string; text?: string }> };
		expect(user.content[0]?.text).toContain("代码块已折叠"); // T1 fold 同批执行
	});

	it("Tier 3（≥95%）v1 无额外动作，仅记录档位", () => {
		// 大配重：候选蒸干后水位仍 ≥95%，才会记 tier 3
		const wire = [ballast(20000), ...typicalWire()];
		const state = createEvapState();
		const { messages, batch } = evap(wire, state, windowFor(wire, 97));
		expect(batch.tier).toBe(3);
		// T3 不 cancel、不整体摘要：输出仍是 snip/stub 形态，消息数不变
		expect(messages.length).toBe(wire.length);
		expect(resultText(messages, 3)).toContain("输出已淘汰");
	});
});

// ---------- usage 口径 ----------

describe("水位口径", () => {
	it("usageTokens 优先于内部估算（1M 模型窗口语义由调用方纠正）", () => {
		const wire = typicalWire();
		const state = createEvapState();
		const w = windowFor(wire, 90);
		const forced = evap(wire, state, w, Math.round(w * 0.5)); // usage 说 50% → Tier 0
		expect(forced.batch.tier).toBe(0);
		expect(forced.messages).toBe(wire);
	});

	it("usageTokens = null 时内部估算兜底（compaction 后首轮）", () => {
		const wire = typicalWire();
		const state = createEvapState();
		const r = evap(wire, state, windowFor(wire, 70), null);
		expect(r.batch.tier).toBe(1);
		expect(r.batch.usagePct).toBeGreaterThanOrEqual(60);
	});
});

// ---------- trimAssistantText（默认关） ----------

describe("trimAssistantText（replay 否决项，默认关）", () => {
	it("默认 false：老 assistant 文本任何水位不动", () => {
		const longAssistantText = `这是第一段结论。${"详细分析。".repeat(200)}`;
		const wire: EvapWireMessage[] = [
			userText("分析"),
			{
				role: "assistant",
				content: [{ type: "text", text: longAssistantText }],
				timestamp: 1,
			},
			assistantToolCall("c1", "read", { path: "/tmp/a.ts" }),
			toolResult("c1", "read", readLines(40)),
			userText("继续"),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90));
		expect(messages[1]).toBe(wire[1]);
	});

	it("显式开启：Tier 2 留前两句 + 省略标记", () => {
		const longAssistantText = `这是第一句。这是第二句。${"后续内容。".repeat(200)}`;
		const wire: EvapWireMessage[] = [
			userText("分析"),
			{
				role: "assistant",
				content: [{ type: "text", text: longAssistantText }],
				timestamp: 1,
			},
			assistantToolCall("c1", "read", { path: "/tmp/a.ts" }),
			toolResult("c1", "read", readLines(40)),
			userText("继续"),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90), null, {
			...TEST_CONFIG,
			trimAssistantText: true,
		});
		const out = messages[1] as { content: Array<{ type: string; text?: string }> };
		expect(out.content[0]?.text).toBe("这是第一句。这是第二句。…（后文 1000 字已省略）");
	});
});

// ---------- 冷启动超集（property 风格） ----------

describe("冷启动重算决策集 ⊇ live 决策集", () => {
	it("逐步 live 与一次性冷启动：冷启动 stub 集 ⊇ live stub 集", () => {
		const wire: EvapWireMessage[] = [userText("开始")];
		for (let i = 0; i < 8; i++) {
			wire.push(assistantToolCall(`c${i}`, i % 2 === 0 ? "read" : "bash", {}));
			wire.push(toolResult(`c${i}`, i % 2 === 0 ? "read" : "bash", readLines(40 + i * 10, 25 + i * 5)));
			if (i % 3 === 0) wire.push(userText(`第 ${i} 轮`));
		}
		const windowTokens = Math.round((totalTokens(wire) / 0.92) as number);

		const liveState = createEvapState();
		const liveStubbed = new Set<string>();
		for (let k = 1; k <= wire.length; k++) {
			evaporateWire(wire.slice(0, k), liveState, TEST_CONFIG, { windowTokens, usageTokens: null });
			for (const v of inspectParts(wire.slice(0, k), liveState, TEST_CONFIG)) {
				if (v.level === "stub") liveStubbed.add(v.key);
			}
		}

		const coldState = createEvapState();
		evaporateWire(wire, coldState, TEST_CONFIG, { windowTokens, usageTokens: null });
		const coldStubbed = new Set(
			inspectParts(wire, coldState, TEST_CONFIG)
				.filter((v) => v.level === "stub")
				.map((v) => v.key),
		);
		for (const k of liveStubbed) {
			expect(coldStubbed.has(k)).toBe(true);
		}
		expect(coldStubbed.size).toBeGreaterThanOrEqual(liveStubbed.size);
	});
});

// ---------- tier2Scope ----------

describe("tier2Scope=gt4k：小输出不 stub", () => {
	it("≤4096B 的 command 输出保持 snip 形态不升 stub", () => {
		const medium = readLines(70, 60); // ≈4.4KB > 4096 阈值
		const small = readLines(40, 40); // ≈1.8KB ≤ 4096
		const wire = [
			ballast(20000),
			userText("跑"),
			assistantToolCall("c1", "bash", {}),
			toolResult("c1", "bash", small),
			userText("好"),
			assistantToolCall("c2", "bash", {}),
			toolResult("c2", "bash", medium),
			userText("继续"),
			assistantToolCall("c3", "read", { path: "/tmp/c.ts" }),
			toolResult("c3", "read", readLines(40)),
		];
		const state = createEvapState();
		const { messages } = evap(wire, state, windowFor(wire, 90), null, {
			...TEST_CONFIG,
			tier2Scope: "gt4k",
		});
		// small ≤ 4096B：T1 不截断（也不到阈值）、T2 不 stub
		expect(resultText(messages, 3)).toBe(small);
		// medium > 4096B：T2 stub
		expect(resultText(messages, 6)).toContain("已淘汰");
	});
});
