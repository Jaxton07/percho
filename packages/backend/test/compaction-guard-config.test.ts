import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCompactionGuardConfig } from "../src/tools/compaction-guard/config";
import { DEFAULT_COMPACTION_GUARD_CONFIG } from "../src/tools/compaction-guard/types";

/**
 * 配置容错（spec D7）：缺 key / 非法值逐字段回退默认值；读失败 fail-soft；
 * 默认值即产品行为（默认常开、80% 触发、cap 0.5、保护区 2 轮、toolResult 300、冷却 30s）。
 */

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "compaction-guard-config-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeSettings(content: string): Promise<void> {
	await writeFile(join(dir, "settings.json"), content);
}

describe("readCompactionGuardConfig", () => {
	it("settings.json 不存在 → 全默认值", () => {
		expect(readCompactionGuardConfig(dir)).toEqual(DEFAULT_COMPACTION_GUARD_CONFIG);
	});

	it("默认值 = 产品行为（默认常开、80%、cap 0.5、保护区 2、300 字符、30s 冷却）", () => {
		expect(DEFAULT_COMPACTION_GUARD_CONFIG).toEqual({
			enabled: true,
			thresholdPct: 80,
			hardCapRatio: 0.5,
			protectTurns: 2,
			toolResultChars: 300,
			cooldownMs: 30_000,
		});
	});

	it("缺 compactionGuard 键 / 空对象 → 全默认值（其余键不干扰）", async () => {
		await writeSettings(JSON.stringify({ defaultModel: "glm-5.3", contextEvaporation: { enabled: false } }));
		expect(readCompactionGuardConfig(dir)).toEqual(DEFAULT_COMPACTION_GUARD_CONFIG);
		await writeSettings(JSON.stringify({ compactionGuard: {} }));
		expect(readCompactionGuardConfig(dir)).toEqual(DEFAULT_COMPACTION_GUARD_CONFIG);
	});

	it("部分覆盖：显式字段生效，缺字段补默认", async () => {
		await writeSettings(JSON.stringify({ compactionGuard: { thresholdPct: 60, toolResultChars: 120 } }));
		const config = readCompactionGuardConfig(dir);
		expect(config.thresholdPct).toBe(60);
		expect(config.toolResultChars).toBe(120);
		expect(config.enabled).toBe(true);
		expect(config.hardCapRatio).toBe(0.5);
		expect(config.protectTurns).toBe(2);
		expect(config.cooldownMs).toBe(30_000);
	});

	it("只有显式 false 才关（逃生舱）", async () => {
		await writeSettings(JSON.stringify({ compactionGuard: { enabled: false } }));
		expect(readCompactionGuardConfig(dir).enabled).toBe(false);
		await writeSettings(JSON.stringify({ compactionGuard: { enabled: "no" } }));
		// 非法值（非 false）→ 默认开
		expect(readCompactionGuardConfig(dir).enabled).toBe(true);
	});

	it("非法值逐字段回退默认（不做夹紧：脏值一律按默认，行为可预测）", async () => {
		await writeSettings(
			JSON.stringify({
				compactionGuard: {
					thresholdPct: 0, // 越界（必须 >0）
					hardCapRatio: 2, // 越界（必须 ≤1）
					protectTurns: -1, // 越界（必须 ≥0）
					toolResultChars: 2.5, // 非整数
					cooldownMs: "30000", // 类型错
				},
			}),
		);
		expect(readCompactionGuardConfig(dir)).toEqual(DEFAULT_COMPACTION_GUARD_CONFIG);

		await writeSettings(
			JSON.stringify({
				compactionGuard: { thresholdPct: 101, hardCapRatio: Number.NaN, protectTurns: 0, cooldownMs: 0 },
			}),
		);
		const config = readCompactionGuardConfig(dir);
		expect(config.thresholdPct).toBe(80); // 101 越界 → 默认
		expect(config.hardCapRatio).toBe(0.5); // NaN → 默认
		expect(config.protectTurns).toBe(0); // 合法边界值
		expect(config.cooldownMs).toBe(0); // 合法边界值（0 = 不冷却）
	});

	it("JSONC 容错（注释 + 尾随逗号）", async () => {
		await writeSettings(`{
			// 内部调参面
			"compactionGuard": {
				"thresholdPct": 70,
				"hardCapRatio": 0.4,
			},
		}`);
		const config = readCompactionGuardConfig(dir);
		expect(config.thresholdPct).toBe(70);
		expect(config.hardCapRatio).toBe(0.4);
	});

	it("文件损坏 → 按默认值处理，不抛", async () => {
		await writeSettings("{ 这不是 JSON");
		expect(readCompactionGuardConfig(dir)).toEqual(DEFAULT_COMPACTION_GUARD_CONFIG);
	});

	it("compactionGuard 是数组/字符串等非对象 → 默认值", async () => {
		await writeSettings(JSON.stringify({ compactionGuard: [1, 2, 3] }));
		expect(readCompactionGuardConfig(dir)).toEqual(DEFAULT_COMPACTION_GUARD_CONFIG);
	});
});
