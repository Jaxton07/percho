import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { CacheWarmingSettings } from "../src/settings/cache-warming";

const roots: string[] = [];
function dir() {
	const base = resolve("../../.local/tmp/cache-warming-tests");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "run-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function session() {
	const settingsManager = SettingsManager.inMemory();
	return {
		sessionId: "session-one",
		sessionName: "test session",
		settingsManager,
		cacheWarmingStatus: { state: "inactive" as const, reason: "waiting for first request" },
		setCacheWarmingMode: vi.fn((mode: "off" | "streaming" | "idle") =>
			settingsManager.setCacheWarmingMode(mode),
		),
	};
}
it("保留默认模式；保存到所属环境并更新存活会话，不影响其他设置和环境", async () => {
	const root = dir(),
		other = dir();
	writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultModel: "kept" }));
	const live = session();
	const settings = new CacheWarmingSettings(
		() => root,
		() => [live],
	);
	expect(settings.get().mode).toBe("idle");
	const saved = await settings.set("streaming");
	expect(saved.mode).toBe("streaming");
	expect(live.setCacheWarmingMode).toHaveBeenCalledWith("streaming");
	expect(saved.sessions[0]).toMatchObject({ name: "test session", mode: "streaming", reason: "waiting" });
	expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toMatchObject({
		defaultModel: "kept",
		cacheWarming: "streaming",
	});
	expect(
		new CacheWarmingSettings(
			() => other,
			() => [],
		).get().mode,
	).toBe("idle");
	await settings.set("off");
	expect(live.setCacheWarmingMode).toHaveBeenLastCalledWith("off");
});
it("无效模式遵循 SDK 默认值，不改写原设置", () => {
	const root = dir();
	const original = JSON.stringify({ cacheWarming: "invalid" });
	writeFileSync(join(root, "settings.json"), original);
	const settings = new CacheWarmingSettings(
		() => root,
		() => [],
	);
	expect(settings.get().mode).toBe("idle");
	expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(original);
});

it.each(["off", "streaming", "idle"] as const)("保留显式模式 %s，读取不迁移设置", (mode) => {
	const root = dir();
	const original = JSON.stringify({ cacheWarming: mode, defaultModel: "kept" });
	writeFileSync(join(root, "settings.json"), original);
	const settings = new CacheWarmingSettings(
		() => root,
		() => [],
	);
	expect(settings.get().mode).toBe(mode);
	expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(original);
});

it("持久化失败不上报成功，也不更新存活会话", async () => {
	const root = dir();
	writeFileSync(join(root, "settings.json"), "{");
	const live = session();
	await expect(
		new CacheWarmingSettings(
			() => root,
			() => [live],
		).set("idle"),
	).rejects.toThrow();
	expect(live.setCacheWarmingMode).not.toHaveBeenCalled();
});
it("并发保存与会话注册串行，新会话不会保留构造时的旧模式", async () => {
	const root = dir();
	const sessions: ReturnType<typeof session>[] = [];
	const settings = new CacheWarmingSettings(
		() => root,
		() => sessions,
	);
	const live = session();
	const streaming = settings.set("streaming");
	const register = settings.register(live, () => sessions.push(live));
	const off = settings.set("off");
	await Promise.all([streaming, register, off]);
	expect(settings.get().mode).toBe("off");
	expect(live.settingsManager.getCacheWarmingMode()).toBe("off");
	expect(live.setCacheWarmingMode.mock.calls.map(([mode]) => mode)).toEqual(["streaming", "off"]);
});

it("一个会话同步失败也继续关闭其他会话", async () => {
	const root = dir();
	const first = session(),
		second = session();
	vi.spyOn(first.settingsManager, "flush").mockRejectedValueOnce(new Error("flush failed"));
	const settings = new CacheWarmingSettings(
		() => root,
		() => [first, second],
	);
	await expect(settings.set("off")).rejects.toThrow("flush failed");
	expect(second.setCacheWarmingMode).toHaveBeenCalledWith("off");
	expect(second.settingsManager.getCacheWarmingMode()).toBe("off");
	expect(settings.get().mode).toBe("off");
});
it("按 SDK 真实状态投影下次时间与等待原因", () => {
	const live = session();
	const get = () => new CacheWarmingSettings(dir, () => [live]).get().sessions[0];
	expect(get()).toMatchObject({ state: "inactive", reason: "waiting" });
	live.cacheWarmingStatus.reason = "cache economics unavailable";
	expect(get().reason).toBe("uneconomical");
	Object.assign(live, {
		cacheWarmingStatus: { state: "scheduled", nextWarmAt: 12345, decision: { phase: "idle" } },
	});
	expect(get()).toMatchObject({ state: "scheduled", nextWarmAt: 12345, phase: "idle" });
});
