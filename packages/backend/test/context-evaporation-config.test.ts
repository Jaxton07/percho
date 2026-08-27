import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearEvapConfigCache,
	readContextManagerMode,
	readEvapConfig,
	writeContextManagerMode,
} from "../src/tools/context-evaporation/config";
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

describe("readContextManagerMode（二态派生）", () => {
	it("全新 settings.json（无任何 key）→ evaporation（新默认）", async () => {
		await writeSettings({ defaultModel: "glm-5.3" });
		expect(readContextManagerMode(dir)).toBe("evaporation");
	});

	it("contextEvaporation.enabled=true → evaporation", async () => {
		await writeSettings({ contextEvaporation: { enabled: true } });
		expect(readContextManagerMode(dir)).toBe("evaporation");
	});

	it("contextEvaporation.enabled=false → off", async () => {
		await writeSettings({ contextEvaporation: { enabled: false } });
		expect(readContextManagerMode(dir)).toBe("off");
	});

	it("遗留 acpCompressionEnabled 任意值不影响派生（true/缺 key/false 均按蒸发语义）", async () => {
		await writeSettings({
			acpCompressionEnabled: true,
			contextEvaporation: { enabled: true },
		});
		expect(readContextManagerMode(dir)).toBe("evaporation");

		await writeSettings({ acpCompressionEnabled: false });
		expect(readContextManagerMode(dir)).toBe("evaporation");

		await writeSettings({ acpCompressionEnabled: false, contextEvaporation: { enabled: false } });
		expect(readContextManagerMode(dir)).toBe("off");
	});

	it("contextEvaporation 非法值（非 false）→ 视为蒸发", async () => {
		await writeSettings({ contextEvaporation: { enabled: "sure" } });
		expect(readContextManagerMode(dir)).toBe("evaporation");
	});
});

describe("writeContextManagerMode（单一写者原子写）", () => {
	it("mode=evaporation → enabled=true 且遗留 acpCompressionEnabled 键被清除，其余键保留", async () => {
		await writeSettings({ defaultModel: "glm-5.3", acpCompressionEnabled: true });
		writeContextManagerMode(dir, "evaporation");
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(raw.defaultModel).toBe("glm-5.3"); // 其余键不动
		expect("acpCompressionEnabled" in raw).toBe(false); // 遗留键收敛清除
		expect((raw.contextEvaporation as { enabled: boolean }).enabled).toBe(true);
	});

	it("mode=off → enabled=false 且遗留 acpCompressionEnabled 键同样被清除", async () => {
		await writeSettings({ acpCompressionEnabled: false, contextEvaporation: { enabled: true } });
		writeContextManagerMode(dir, "off");
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect("acpCompressionEnabled" in raw).toBe(false);
		expect((raw.contextEvaporation as { enabled: boolean }).enabled).toBe(false);
	});

	it("无遗留键时写入不新增 acpCompressionEnabled", async () => {
		await writeSettings({});
		writeContextManagerMode(dir, "evaporation");
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect("acpCompressionEnabled" in raw).toBe(false);
		expect((raw.contextEvaporation as { enabled: boolean }).enabled).toBe(true);
	});

	it("数值子键保留（只动 enabled，不覆盖整个 contextEvaporation 对象）", async () => {
		await writeSettings({
			contextEvaporation: { enabled: true, budgetTokens: 160000, tiers: { snip: 70 } },
		});
		writeContextManagerMode(dir, "off");
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
			contextEvaporation: Record<string, unknown>;
		};
		expect(raw.contextEvaporation.budgetTokens).toBe(160000);
		expect((raw.contextEvaporation.tiers as { snip: number }).snip).toBe(70);
	});

	it("写后清缓存：读立即见新值", async () => {
		await writeSettings({});
		expect(readContextManagerMode(dir)).toBe("evaporation");

		writeContextManagerMode(dir, "off");
		expect(readContextManagerMode(dir)).toBe("off"); // 缓存已清

		writeContextManagerMode(dir, "evaporation");
		expect(readContextManagerMode(dir)).toBe("evaporation");
	});

	it("设置页路径写出的二态与派生读一致（不残留双开）", async () => {
		await writeSettings({});
		for (const mode of ["evaporation", "off"] as const) {
			writeContextManagerMode(dir, mode);
			const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
				acpCompressionEnabled?: boolean;
				contextEvaporation?: { enabled?: boolean };
			};
			expect(raw.acpCompressionEnabled).toBeUndefined(); // 无遗留键
			expect(raw.contextEvaporation?.enabled).toBe(mode === "evaporation");
			expect(readContextManagerMode(dir)).toBe(mode); // 派生读与写入意图一致
		}
	});
});
