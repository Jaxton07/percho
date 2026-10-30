import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearEvapConfigCache, readEvapConfig } from "../src/tools/context-evaporation/config";
import { DEFAULT_EVAP_CONFIG } from "../src/tools/context-evaporation/types";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "evap-config-test-"));
	clearEvapConfigCache();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeSettings(obj: unknown): Promise<void> {
	await writeFile(join(dir, "settings.json"), JSON.stringify(obj));
	clearEvapConfigCache();
}

describe("readEvapConfig（对象整体容错）", () => {
	it("settings.json 不存在 → 全默认值", () => {
		expect(readEvapConfig(dir)).toEqual(DEFAULT_EVAP_CONFIG);
	});

	it("缺 contextEvaporation 键 → 全默认值（其余键不干扰）", async () => {
		await writeSettings({ defaultModel: "glm-5.3", acpCompressionEnabled: true });
		expect(readEvapConfig(dir)).toEqual(DEFAULT_EVAP_CONFIG);
	});

	it("部分覆盖：缺字段补默认，显式字段生效", async () => {
		await writeSettings({
			contextEvaporation: {
				enabled: true,
				tiers: { snip: 70 },
				budgetTokens: 160000,
			},
		});
		const config = readEvapConfig(dir);
		expect(config.tiers.snip).toBe(70);
		expect(config.tiers.prune).toBe(85); // 缺字段补默认
		expect(config.budgetTokens).toBe(160000);
		expect(config.protectionTokens).toBe(8000);
		expect(config.tier2Scope).toBe("all");
	});

	it("非法值逐字段回退默认（字符串数字 / 负数 / 非法枚举 / 非字符串数组项）", async () => {
		await writeSettings({
			contextEvaporation: {
				enabled: "yes",
				tiers: { snip: "60", prune: -1 },
				budgetTokens: Number.NaN,
				protectionTokens: 0,
				tier2Scope: "everything",
				trimAssistantText: "no",
				protectedTools: ["todo", 42, null],
			},
		});
		const config = readEvapConfig(dir);
		expect(config.tiers.snip).toBe(60);
		expect(config.tiers.prune).toBe(85);
		expect(config.budgetTokens).toBe(262144);
		expect(config.protectionTokens).toBe(8000);
		expect(config.tier2Scope).toBe("all");
		expect(config.trimAssistantText).toBe(false); // 仅显式 true 才开
		expect(config.protectedTools).toEqual(["todo"]);
	});

	it("contextEvaporation 非对象（数组/字符串）→ 全默认", async () => {
		await writeSettings({ contextEvaporation: [1, 2] });
		expect(readEvapConfig(dir)).toEqual(DEFAULT_EVAP_CONFIG);
	});

	it("JSONC（注释 + 尾随逗号）容忍解析", async () => {
		await writeFile(
			join(dir, "settings.json"),
			`{\n  // 用户级配置\n  "contextEvaporation": { "enabled": true, "budgetTokens": 160000, },\n}`,
		);
		clearEvapConfigCache();
		expect(readEvapConfig(dir).budgetTokens).toBe(160000);
	});
});
