import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isModelVisible } from "@percho/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonStore } from "../src/json-store";
import { ModelPrefsService } from "../src/settings/model-prefs";

const dirs: string[] = [];
async function makeService() {
	const root = fileURLToPath(
		new URL("../../../.local/tmp/issues-100-101-stage2/model-prefs", import.meta.url),
	);
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "prefs-"));
	dirs.push(dir);
	const path = join(dir, "model-prefs.json");
	return { path, service: new ModelPrefsService(path) };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ModelPrefsService provider defaults", () => {
	it("空批量保持零写盘，但仍按队列读取先前修改", async () => {
		const { service } = await makeService();
		const write = vi.spyOn(JsonStore.prototype, "write");
		const changed = service.setProviderModelsHidden("p", true);
		const empty = service.setModelsHidden("p", ["", " "], false);
		await changed;
		expect((await empty).hiddenProviders).toEqual(["p"]);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("零目录建立默认隐藏，白名单例外与新增模型策略重启后保留", async () => {
		const { path, service } = await makeService();
		await service.setProviderModelsHidden(" p ", true);
		expect(await service.isModelHidden("p", "future")).toBe(true);
		await service.setModelHidden("p", " a ", false);
		const restart = new ModelPrefsService(path);
		expect(await restart.getPrefs()).toEqual({
			hiddenModels: {},
			subagentModels: {},
			hiddenProviders: ["p"],
			visibleModels: { p: ["a"] },
		});
		expect(await restart.isModelHidden("p", "a")).toBe(false);
		expect(await restart.isModelHidden("p", "future")).toBe(true);
		await restart.setModelHidden("p", "a", true);
		expect((await restart.getPrefs()).visibleModels).toBeUndefined();
		expect((await restart.getPrefs()).hiddenProviders).toEqual(["p"]);
	});

	it("旧名单全藏不猜全源意图；脏字段规整且空字段不落盘", async () => {
		const { path, service } = await makeService();
		await writeFile(
			path,
			JSON.stringify({ hiddenModels: { " p ": [" b ", "a", "a", null] }, subagentModels: { scout: "p/a" } }),
		);
		expect(await service.getPrefs()).toEqual({
			hiddenModels: { p: ["a", "b"] },
			subagentModels: { scout: "p/a" },
		});
		expect(await service.isModelHidden("p", "new")).toBe(false);
		await service.setModelsHidden("p", ["a", "b"], false);
		const disk = JSON.parse(await readFile(path, "utf8"));
		expect(disk).toEqual({ hiddenModels: {}, subagentModels: { scout: "p/a" } });
		expect(disk).not.toHaveProperty("hiddenProviders");
		expect(disk).not.toHaveProperty("visibleModels");
	});

	it("读取脏新字段，白名单仅保留默认隐藏源；root null 也安全", async () => {
		const { path } = await makeService();
		await writeFile(
			path,
			JSON.stringify({
				hiddenProviders: [" p ", "p", "", 1],
				visibleModels: { p: [" b ", "a", "a", null], orphan: ["x"] },
				hiddenModels: [],
			}),
		);
		expect(await new ModelPrefsService(path).getPrefs()).toEqual({
			hiddenModels: {},
			subagentModels: {},
			hiddenProviders: ["p"],
			visibleModels: { p: ["a", "b"] },
		});
		await writeFile(path, "null");
		expect(await new ModelPrefsService(path).getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
	});

	it("整源操作清理旧黑名单/白名单，批量只改 IDs，最终全显省略空字段", async () => {
		const { path, service } = await makeService();
		await service.setModelsHidden("p", ["old"], true);
		expect((await service.getPrefs()).hiddenProviders).toBeUndefined();
		await service.setProviderModelsHidden("p", true);
		expect((await service.getPrefs()).hiddenModels).toEqual({});
		await service.setModelsHidden("p", ["a", "b"], false);
		expect((await service.getPrefs()).visibleModels).toEqual({ p: ["a", "b"] });
		expect(await service.isModelHidden("p", "new")).toBe(true);
		await service.setProviderModelsHidden("p", true);
		expect((await service.getPrefs()).visibleModels).toBeUndefined();
		await service.setModelHidden("p", "a", false);
		await service.setProviderModelsHidden("p", false);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ hiddenModels: {}, subagentModels: {} });
		expect(await new ModelPrefsService(path).isModelHidden("p", "new")).toBe(false);
	});

	it("所有返回的嵌套集合均隔离 cache", async () => {
		const { service } = await makeService();
		await service.setSubagentModel("scout", "p/a");
		await service.setSubagentThinking("scout", "high");
		await service.setModelHidden("q", "b", true);
		await service.setProviderModelsHidden("p", true);
		const returned = await service.setModelHidden("p", "a", false);
		returned.hiddenProviders?.push("polluted");
		returned.visibleModels?.p.push("new");
		returned.hiddenModels.q.push("bad");
		returned.subagentModels.scout = "bad";
		if (returned.subagentThinking) returned.subagentThinking.scout = "low";
		const fromRead = await service.getPrefs();
		fromRead.visibleModels?.p.push("also-bad");
		expect(await service.getPrefs()).toEqual({
			hiddenModels: { q: ["b"] },
			hiddenProviders: ["p"],
			visibleModels: { p: ["a"] },
			subagentModels: { scout: "p/a" },
			subagentThinking: { scout: "high" },
		});
	});

	it("冷 cache 并发所有偏好变更不丢读改写，读取排在在途修改之后", async () => {
		const { path, service } = await makeService();
		const operations = [
			service.setProviderModelsHidden("p", true),
			service.setModelHidden("p", "a", false),
			service.setModelsHidden("p", ["b", "c"], false),
			service.setModelHidden("q", "x", true),
			service.setSubagentModel("scout", "p/a"),
			service.setSubagentThinking("scout", "high"),
			service.setSubagentPreferBuiltin(false),
		];
		const read = service.getPrefs();
		await Promise.all(operations);
		const expected = {
			hiddenModels: { q: ["x"] },
			hiddenProviders: ["p"],
			visibleModels: { p: ["a", "b", "c"] },
			subagentModels: { scout: "p/a" },
			subagentThinking: { scout: "high" },
			subagentPreferBuiltin: false,
		};
		expect(await read).toEqual(expected);
		expect(await new ModelPrefsService(path).getPrefs()).toEqual(expected);
	});

	it("快速全藏/例外/全显/再全藏按调用顺序持久化，无旧例外复活", async () => {
		const { path, service } = await makeService();
		await Promise.all([
			service.setProviderModelsHidden("p", true),
			service.setModelHidden("p", "a", false),
			service.setProviderModelsHidden("p", false),
			service.setModelHidden("p", "b", true),
			service.setProviderModelsHidden("p", true),
		]);
		const restarted = await new ModelPrefsService(path).getPrefs();
		expect(restarted).toEqual({ hiddenModels: {}, subagentModels: {}, hiddenProviders: ["p"] });
		expect(isModelVisible(restarted, "p", "a")).toBe(false);
	});

	it("真实 IO 写失败不污染 cache/磁盘，移除障碍后队列继续", async () => {
		const { path, service } = await makeService();
		await service.setModelHidden("q", "old", true);
		const before = await service.getPrefs();
		const text = await readFile(path, "utf8");
		await rm(path);
		await mkdir(path); // rename 到目录失败，避免 chmod 在不同权限/平台下不可靠
		await expect(service.setProviderModelsHidden("p", true)).rejects.toThrow();
		expect(await service.getPrefs()).toEqual(before);
		await rm(path, { recursive: true });
		await writeFile(path, text);
		expect(await new ModelPrefsService(path).getPrefs()).toEqual(before);
		await service.setModelHidden("q", "next", true);
		expect((await new ModelPrefsService(path).getPrefs()).hiddenModels).toEqual({ q: ["next", "old"] });
	});

	it("在途失败不发布未写状态；后继读取见旧值，后继修改不携带失败意图", async () => {
		const { path, service } = await makeService();
		await service.setSubagentModel("scout", "q/a");
		const before = await service.getPrefs();
		let release = () => {};
		let entered = () => {};
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		const started = new Promise<void>((r) => {
			entered = r;
		});
		vi.spyOn(JsonStore.prototype, "write").mockImplementationOnce(async () => {
			entered();
			await blocked;
			throw new Error("injected write failure");
		});
		const failed = expect(service.setProviderModelsHidden("p", true)).rejects.toThrow(
			"injected write failure",
		);
		await started;
		const queuedRead = service.getPrefs();
		const next = service.setModelHidden("q", "b", true);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(before);
		release();
		await failed;
		expect(await queuedRead).toEqual(before);
		await next;
		expect(await new ModelPrefsService(path).getPrefs()).toEqual({
			hiddenModels: { q: ["b"] },
			subagentModels: { scout: "q/a" },
		});
	});
});
