import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readCompressionConfig,
	setCompressionTakeover,
	writeCompactionGuardEnabled,
	writeSdkAutoCompression,
} from "./compression";

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
			takeover: false,
			sdkAutoEnabled: true,
			guardEnabled: true,
			evaporationEnabled: true,
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

describe("第三方压缩接管（主开关：快照 → 强关 → 按快照恢复）", () => {
	const takeoverSection = () => readRaw().compressionTakeover as Record<string, unknown>;

	it("开：快照两层当前值并强制关；蒸发派生为关", () => {
		writeSdkAutoCompression(dir, true);
		writeCompactionGuardEnabled(dir, false); // 原本就是关的层
		setCompressionTakeover(dir, true);
		expect(readCompressionConfig(dir)).toMatchObject({
			takeover: true,
			sdkAutoEnabled: false,
			guardEnabled: false,
			evaporationEnabled: false,
		});
		expect(takeoverSection()).toEqual({ enabled: true, saved: { sdk: true, guard: false } });
	});

	it("关：按快照逐项恢复（原本关着的那层不会被打开），并清掉快照", () => {
		writeCompactionGuardEnabled(dir, false);
		setCompressionTakeover(dir, true);
		setCompressionTakeover(dir, false);
		expect(readCompressionConfig(dir)).toMatchObject({
			takeover: false,
			sdkAutoEnabled: true,
			guardEnabled: false,
			evaporationEnabled: true,
		});
		expect(takeoverSection().saved).toBeUndefined();
	});

	it("重复开不覆盖快照；没开过就关 → 不动任何层", () => {
		setCompressionTakeover(dir, true);
		setCompressionTakeover(dir, true);
		expect(takeoverSection().saved).toEqual({ sdk: true, guard: true });
		setCompressionTakeover(dir, false);
		setCompressionTakeover(dir, false);
		expect(readCompressionConfig(dir)).toMatchObject({
			takeover: false,
			sdkAutoEnabled: true,
			guardEnabled: true,
			evaporationEnabled: true,
		});
	});

	it("接管只动 enabled，不碰兄弟调参键", () => {
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({
				compaction: { reserveTokens: 65536 },
				compactionGuard: { thresholdPct: 60 },
				defaultTools: { Bash: true },
			}),
		);
		setCompressionTakeover(dir, true);
		const raw = readRaw();
		expect(raw.compaction).toEqual({ reserveTokens: 65536, enabled: false });
		expect(raw.compactionGuard).toEqual({ thresholdPct: 60, enabled: false });
		expect(raw.defaultTools).toEqual({ Bash: true });
		expect(readCompressionConfig(dir).thresholdPct).toBe(60);
	});
});
