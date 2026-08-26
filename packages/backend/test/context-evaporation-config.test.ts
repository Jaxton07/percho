import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAcpEnabledCache, readAcpEnabled } from "../src/tools/acp-context/config";
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
	clearAcpEnabledCache();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeSettings(obj: unknown): Promise<void> {
	await writeFile(join(dir, "settings.json"), JSON.stringify(obj));
	clearEvapConfigCache();
	clearAcpEnabledCache();
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

describe("readContextManagerMode（双 key 派生全分支）", () => {
	it("全新 settings.json（无任何 key）→ acp（回归底线：默认行为与现状一致）", async () => {
		await writeSettings({ defaultModel: "glm-5.3" });
		expect(readContextManagerMode(dir)).toBe("acp");
	});

	it("evaporation on + acp 显式 false → evaporation", async () => {
		await writeSettings({ acpCompressionEnabled: false, contextEvaporation: { enabled: true } });
		expect(readContextManagerMode(dir)).toBe("evaporation");
	});

	it("evaporation on + acp 缺 key（默认开）→ 双开冲突，ACP 优先", async () => {
		await writeSettings({ contextEvaporation: { enabled: true } });
		expect(readContextManagerMode(dir)).toBe("acp");
	});

	it("evaporation on + acp true → 双开冲突，ACP 优先", async () => {
		await writeSettings({ acpCompressionEnabled: true, contextEvaporation: { enabled: true } });
		expect(readContextManagerMode(dir)).toBe("acp");
	});

	it("evaporation 显式 false + acp false → off", async () => {
		await writeSettings({
			acpCompressionEnabled: false,
			contextEvaporation: { enabled: false },
		});
		expect(readContextManagerMode(dir)).toBe("off");
	});

	it("evaporation 非法值 → 视为关，走 acp 缺省语义", async () => {
		await writeSettings({ contextEvaporation: { enabled: "sure" } });
		expect(readContextManagerMode(dir)).toBe("acp");
	});
});

describe("writeContextManagerMode（单一写者原子双写）", () => {
	it("mode=evaporation → 双 key 同时正确，其余键保留", async () => {
		await writeSettings({ defaultModel: "glm-5.3", acpCompressionEnabled: true });
		writeContextManagerMode(dir, "evaporation");
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(raw.defaultModel).toBe("glm-5.3"); // 其余键不动
		expect(raw.acpCompressionEnabled).toBe(false);
		expect((raw.contextEvaporation as { enabled: boolean }).enabled).toBe(true);
	});

	it("mode=acp → evap false + acp true", async () => {
		await writeSettings({ acpCompressionEnabled: false, contextEvaporation: { enabled: true } });
		writeContextManagerMode(dir, "acp");
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(raw.acpCompressionEnabled).toBe(true);
		expect((raw.contextEvaporation as { enabled: boolean }).enabled).toBe(false);
	});

	it("mode=off → 两者都 false", async () => {
		await writeSettings({ contextEvaporation: { enabled: true } });
		writeContextManagerMode(dir, "off");
		const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
		expect(raw.acpCompressionEnabled).toBe(false);
		expect((raw.contextEvaporation as { enabled: boolean }).enabled).toBe(false);
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

	it("写后清缓存：两侧读立即见新值（互斥即效）", async () => {
		await writeSettings({});
		expect(readContextManagerMode(dir)).toBe("acp");

		writeContextManagerMode(dir, "evaporation");
		expect(readContextManagerMode(dir)).toBe("evaporation"); // 本侧缓存已清
		expect(readAcpEnabled(dir)).toBe(false); // ACP 侧缓存已清

		writeContextManagerMode(dir, "acp");
		expect(readContextManagerMode(dir)).toBe("acp");
		expect(readAcpEnabled(dir)).toBe(true);
	});
});

describe("互斥集成（arch §5 测试层）", () => {
	it("手改文件双开 → 只有 ACP 激活：mode 派生 acp，蒸发 isEnabled 判定 false", async () => {
		await writeSettings({ acpCompressionEnabled: true, contextEvaporation: { enabled: true } });
		// 蒸发扩展的 liveEnabled 基础判定
		const evapActive = readContextManagerMode(dir) === "evaporation";
		expect(evapActive).toBe(false);
		// ACP 侧读自己的 key（互斥的另一半）
		expect(readAcpEnabled(dir)).toBe(true);
	});

	it("设置页路径不可能写出双开（writeContextManagerMode 恒成对写）", async () => {
		await writeSettings({});
		for (const mode of ["evaporation", "acp", "off"] as const) {
			writeContextManagerMode(dir, mode);
			const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as {
				acpCompressionEnabled?: boolean;
				contextEvaporation?: { enabled?: boolean };
			};
			const evapOn = raw.contextEvaporation?.enabled === true;
			const acpOn = raw.acpCompressionEnabled !== false;
			expect(evapOn && acpOn).toBe(false); // 写者保证永不同时为真
			expect(readContextManagerMode(dir)).toBe(mode); // 派生读与写入意图一致
		}
	});
});
