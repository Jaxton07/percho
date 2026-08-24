import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAcpEnabledCache, readAcpEnabled, writeAcpEnabled } from "../src/tools/acp-context/config";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "acp-config-test-"));
	clearAcpEnabledCache();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("readAcpEnabled（P2 默认开语义）", () => {
	it("settings.json 不存在 → 默认开", () => {
		expect(readAcpEnabled(dir)).toBe(true);
	});

	it("缺 acpCompressionEnabled 键 → 默认开", async () => {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultModel: "glm-5.3" }));
		clearAcpEnabledCache();
		expect(readAcpEnabled(dir)).toBe(true);
	});

	it("显式 false → 关；显式 true → 开", async () => {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ acpCompressionEnabled: false }));
		clearAcpEnabledCache();
		expect(readAcpEnabled(dir)).toBe(false);

		await writeFile(join(dir, "settings.json"), JSON.stringify({ acpCompressionEnabled: true }));
		clearAcpEnabledCache();
		expect(readAcpEnabled(dir)).toBe(true);
	});

	it("非法值回退默认开", async () => {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ acpCompressionEnabled: "yes" }));
		clearAcpEnabledCache();
		expect(readAcpEnabled(dir)).toBe(true);
	});

	it("JSONC（注释 + 尾随逗号）容忍解析", async () => {
		await writeFile(join(dir, "settings.json"), `{\n  // 用户级配置\n  "acpCompressionEnabled": false,\n}`);
		clearAcpEnabledCache();
		expect(readAcpEnabled(dir)).toBe(false);
	});

	it("损坏 JSON → 默认开（绝不抛）", async () => {
		await writeFile(join(dir, "settings.json"), "{ not json ,,");
		clearAcpEnabledCache();
		expect(readAcpEnabled(dir)).toBe(true);
	});
});

describe("writeAcpEnabled", () => {
	it("read-modify-write：保留其他键", async () => {
		const file = join(dir, "settings.json");
		await writeFile(file, JSON.stringify({ defaultModel: "glm-5.3", packages: ["npm:x"] }, null, 2));

		writeAcpEnabled(dir, false);

		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(parsed.acpCompressionEnabled).toBe(false);
		expect(parsed.defaultModel).toBe("glm-5.3");
		expect(parsed.packages).toEqual(["npm:x"]);
	});

	it("写后读缓存已清：立即读到新值（不等 TTL）", async () => {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ acpCompressionEnabled: true }));
		expect(readAcpEnabled(dir)).toBe(true); // 此时进缓存

		writeAcpEnabled(dir, false);
		expect(readAcpEnabled(dir)).toBe(false);
	});

	it("无文件时创建仅含开关的 settings.json", async () => {
		const file = join(dir, "settings.json");
		writeAcpEnabled(dir, true);
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		expect(parsed.acpCompressionEnabled).toBe(true);
	});

	it("损坏文件拒写（上抛，不拿 default 覆盖真数据）", async () => {
		const file = join(dir, "settings.json");
		await writeFile(file, "{ broken ,,");
		expect(() => writeAcpEnabled(dir, true)).toThrow();
		// 原文未被覆盖
		expect(await readFile(file, "utf8")).toBe("{ broken ,,");
	});
});
