import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// userData 指到临时目录：不触碰真实 Percho 数据
const env = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => env.dir } }));

import { PLUGIN_STATE_MAX_BYTES, readPluginState, writePluginState } from "./plugin-state";

const file = (name: string) => join(env.dir, "ui-plugin-state", `${name}.json`);

beforeEach(() => {
	env.dir = mkdtempSync(join(tmpdir(), "percho-plugin-state-"));
});
afterEach(() => rmSync(env.dir, { recursive: true, force: true }));

describe("plugin state store", () => {
	it("round-trips per plugin and keeps plugins separate", async () => {
		await writePluginState("ds-whale-maid", "offset", { x: -120, y: 40 });
		await writePluginState("ds-whale-maid", "muted", true);
		await writePluginState("voice-alerts", "offset", { x: 1, y: 1 });
		expect(await readPluginState("ds-whale-maid")).toEqual({ offset: { x: -120, y: 40 }, muted: true });
		expect(await readPluginState("voice-alerts")).toEqual({ offset: { x: 1, y: 1 } });
		expect(JSON.parse(readFileSync(file("ds-whale-maid"), "utf8"))).toEqual({
			offset: { x: -120, y: 40 },
			muted: true,
		});
	});

	it("undefined deletes a key; missing and corrupt files read as empty", async () => {
		expect(await readPluginState("nobody")).toEqual({});
		await writePluginState("demo", "a", 1);
		await writePluginState("demo", "a", undefined);
		expect(await readPluginState("demo")).toEqual({});
		mkdirSync(join(env.dir, "ui-plugin-state"), { recursive: true });
		writeFileSync(file("broken"), "{not json");
		expect(await readPluginState("broken")).toEqual({});
		// 坏文件不阻塞下次写入
		await writePluginState("broken", "a", 2);
		expect(await readPluginState("broken")).toEqual({ a: 2 });
	});

	it("stores plain JSON only (functions dropped, Date as string) and rejects unserialisable values", async () => {
		await writePluginState("demo", "v", { when: new Date(0), fn: () => 1, n: 1 });
		expect(await readPluginState("demo")).toEqual({ v: { when: "1970-01-01T00:00:00.000Z", n: 1 } });
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(writePluginState("demo", "c", cyclic)).rejects.toThrow("JSON-serialisable");
		await expect(writePluginState("demo", "b", 1n)).rejects.toThrow("JSON-serialisable");
		await expect(writePluginState("demo", "f", () => 1)).rejects.toThrow("JSON-serialisable");
	});

	it("rejects bad plugin names and keys before touching disk (no path escape)", async () => {
		for (const name of ["../escape", "A", "", "a/b", "..\\x"])
			await expect(writePluginState(name, "k", 1)).rejects.toThrow("Invalid plugin name");
		for (const key of ["", "__proto__", "../k", "a b", "x".repeat(65)])
			await expect(writePluginState("demo", key, 1)).rejects.toThrow("Invalid state key");
		expect(existsSync(join(env.dir, "ui-plugin-state"))).toBe(false);
		expect(await readPluginState("../escape")).toEqual({});
	});

	it("enforces the size and key-count limits without losing existing data", async () => {
		await writePluginState("demo", "keep", "yes");
		await expect(writePluginState("demo", "big", "x".repeat(PLUGIN_STATE_MAX_BYTES))).rejects.toThrow(
			"exceeds",
		);
		for (let i = 0; i < 63; i++) await writePluginState("demo", `k${i}`, i);
		await expect(writePluginState("demo", "one-too-many", 1)).rejects.toThrow("Too many state keys");
		const state = await readPluginState("demo");
		expect(state.keep).toBe("yes");
		expect(Object.keys(state)).toHaveLength(64);
	});

	it("drops keys that do not match the key rule when reading a hand-edited file", async () => {
		mkdirSync(join(env.dir, "ui-plugin-state"), { recursive: true });
		writeFileSync(file("demo"), JSON.stringify({ ok: 1, "bad key": 2, constructor: 3 }));
		expect(await readPluginState("demo")).toEqual({ ok: 1, constructor: 3 });
	});
});
