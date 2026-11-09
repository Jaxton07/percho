import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCompressionConfig, writeCompactionGuardEnabled, writeSdkAutoCompression } from "./compression";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "percho-compression-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const readRaw = () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;

describe("压缩两层开关（settings.json）", () => {
	it("缺 settings.json → 两层都按默认开，阈值取默认 80", () => {
		expect(existsSync(join(dir, "settings.json"))).toBe(false);
		expect(readCompressionConfig(dir)).toEqual({
			sdkAutoEnabled: true,
			guardEnabled: true,
			thresholdPct: 80,
		});
	});

	it("只有显式 false 才关；缺 key 视为开", () => {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ compaction: {}, compactionGuard: { cooldownMs: 5000 } }),
		);
		expect(readCompressionConfig(dir)).toMatchObject({
			sdkAutoEnabled: true,
			guardEnabled: true,
			thresholdPct: 80,
		});
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		expect(readCompressionConfig(dir)).toMatchObject({ sdkAutoEnabled: false, guardEnabled: true });
	});

	it("关 SDK 自动压缩不吞掉同段兄弟键（reserveTokens 是运营调参面）", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 65536 } }));
		writeSdkAutoCompression(dir, false);
		expect(readRaw().compaction).toEqual({ reserveTokens: 65536, enabled: false });
		expect(readCompressionConfig(dir).sdkAutoEnabled).toBe(false);
	});

	it("关护栏不吞掉阈值/冷却调参键，且阈值回读到 UI", () => {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ compactionGuard: { thresholdPct: 60, hardCapRatio: 0.4 } }),
		);
		writeCompactionGuardEnabled(dir, false);
		expect(readRaw().compactionGuard).toEqual({ thresholdPct: 60, hardCapRatio: 0.4, enabled: false });
		expect(readCompressionConfig(dir)).toMatchObject({ guardEnabled: false, thresholdPct: 60 });
	});

	it("两层互不串味：只关护栏，SDK 仍是开", () => {
		writeSdkAutoCompression(dir, true);
		writeCompactionGuardEnabled(dir, false);
		expect(readCompressionConfig(dir)).toMatchObject({ sdkAutoEnabled: true, guardEnabled: false });
	});

	it("JSONC（带注释）能读；写后文件仍是合法 JSON", () => {
		writeFileSync(join(dir, "settings.json"), `{\n\t// 运营手改过\n\t"compaction": { "enabled": false },\n}`);
		expect(readCompressionConfig(dir).sdkAutoEnabled).toBe(false);
		writeCompactionGuardEnabled(dir, true);
		expect(() => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).not.toThrow();
	});

	it("损坏的 settings.json：读 fail-soft（按默认开），写拒写不上手改", () => {
		writeFileSync(join(dir, "settings.json"), "{ 这不是 json");
		expect(readCompressionConfig(dir)).toMatchObject({ sdkAutoEnabled: true, guardEnabled: true });
		expect(() => writeSdkAutoCompression(dir, false)).toThrow();
	});
});
