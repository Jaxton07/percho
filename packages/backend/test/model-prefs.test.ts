import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelPrefsService } from "../src/settings/model-prefs";

async function makeService() {
	const dir = await mkdtemp(join(tmpdir(), "percho-model-prefs-"));
	return {
		dir,
		path: join(dir, "model-prefs.json"),
		service: new ModelPrefsService(join(dir, "model-prefs.json")),
	};
}

describe("ModelPrefsService", () => {
	it("读写隐藏模型与子代理模型，删除配置后回到继承", async () => {
		const { service } = await makeService();
		expect(await service.getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
		await service.setModelHidden("deepseek", "v4-flash", true);
		await service.setSubagentModel("scout", "deepseek/v4-flash");
		expect(await service.getPrefs()).toEqual({
			hiddenModels: { deepseek: ["v4-flash"] },
			subagentModels: { scout: "deepseek/v4-flash" },
		});
		await service.setModelHidden("deepseek", "v4-flash", false);
		await service.setSubagentModel("scout", null);
		expect(await service.getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
	});

	it("原子写不遗留临时文件", async () => {
		const { dir, service } = await makeService();
		await service.setModelHidden("p", "m", true);
		expect((await readdir(dir)).sort()).toEqual(["model-prefs.json"]);
	});

	it("损坏文件安全回退为空配置", async () => {
		const { path, service } = await makeService();
		await writeFile(path, "{broken", "utf8");
		expect(await service.getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
	});

	describe("subagentThinking（#47）", () => {
		it("读写逐代理思考档位；null 删除键", async () => {
			const { service } = await makeService();
			expect(await service.getSubagentThinking("scout")).toBeUndefined();
			await service.setSubagentThinking("scout", "low");
			expect(await service.getSubagentThinking("scout")).toBe("low");
			expect(await service.getPrefs()).toEqual({
				hiddenModels: {},
				subagentModels: {},
				subagentThinking: { scout: "low" },
			});
			await service.setSubagentThinking("scout", null);
			expect(await service.getSubagentThinking("scout")).toBeUndefined();
			// 空 map 不写进 json（向后兼容旧文件形状）
			expect(await service.getPrefs()).toEqual({ hiddenModels: {}, subagentModels: {} });
		});

		it("非法档位拒写，脏 json 值读侧白名单丢弃", async () => {
			const { path, service } = await makeService();
			await expect(service.setSubagentThinking("scout", "ultra")).rejects.toThrow(/invalid thinking/);
			await writeFile(
				path,
				JSON.stringify({
					subagentThinking: { scout: "ultra", reviewer: "high", blank: "  " },
				}),
				"utf8",
			);
			const fresh = new ModelPrefsService(path);
			expect(await fresh.getPrefs()).toEqual({
				hiddenModels: {},
				subagentModels: {},
				subagentThinking: { reviewer: "high" },
			});
		});
	});

	describe("subagentPreferBuiltin（#47）", () => {
		it("缺省 true，可写 false 再开关回 true", async () => {
			const { service } = await makeService();
			expect(await service.getSubagentPreferBuiltin()).toBe(true);
			await service.setSubagentPreferBuiltin(false);
			expect(await service.getSubagentPreferBuiltin()).toBe(false);
			expect(await service.getPrefs()).toMatchObject({ subagentPreferBuiltin: false });
			await service.setSubagentPreferBuiltin(true);
			expect(await service.getSubagentPreferBuiltin()).toBe(true);
		});

		it("旧 json 无新字段时行为同现状；脏值按 true 处理", async () => {
			const { path } = await makeService();
			await writeFile(
				path,
				JSON.stringify({ hiddenModels: {}, subagentModels: { scout: "p/m" }, subagentPreferBuiltin: "nope" }),
				"utf8",
			);
			const legacy = new ModelPrefsService(path);
			expect(await legacy.getSubagentPreferBuiltin()).toBe(true);
			expect(await legacy.getSubagentModel("scout")).toBe("p/m");
			expect(await legacy.getPrefs()).toEqual({
				hiddenModels: {},
				subagentModels: { scout: "p/m" },
			});
		});
	});
});
