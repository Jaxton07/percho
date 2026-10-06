import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../src/project/builtin-extensions";
import { composeExtensionFactories } from "../src/project/trust-loader";

/**
 * 这条顺序是语义，不是风格：`getAllRegisteredTools()` 是「**同组内先注册者赢**」
 * （`if (!toolsByName.has(name)) set(…)`），所以我们必须排在官方内置之前。
 * 详见 `composeExtensionFactories` 的注释与 PITFALLS「同名工具」条目。
 */
describe("内置扩展与自研扩展的注册顺序", () => {
	it("我们的扩展在前、官方内置在后（顺序即语义）", () => {
		const ours = [{ name: "ours", factory: () => {} }];
		const composed = composeExtensionFactories(ours, {});
		expect(composed[0]).toBe(ours[0]);
		expect(composed.slice(1).map((e) => (typeof e === "function" ? "?" : e.name))).toEqual([
			"codemode",
			"tool-search",
			"mcp",
		]);
	});

	it("官方内置带 builtin + replaceable 元数据；我们自己的不带（将来同名时让位的是官方）", () => {
		const builtins = builtinExtensions({});
		for (const builtin of builtins) {
			if (typeof builtin === "function" || !("name" in builtin))
				throw new Error("expected named inline extension");
			expect(builtin.builtin).toBe(true);
			expect(builtin.replaceable).toBe(true);
		}
		const ours = composeExtensionFactories([{ name: "ours", factory: () => {} }], {}).slice(0, 1);
		for (const mine of ours) {
			if (typeof mine === "function" || !("name" in mine)) throw new Error("expected named inline extension");
			expect(mine.builtin).toBeUndefined();
			expect(mine.replaceable).toBeUndefined();
		}
	});

	it("同名工具实战：先注册者赢；官方 replaceable 的那份会被挤出局", async () => {
		const root = mkdtempSync(join(tmpdir(), "percho-ext-order-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sameNameTool = (label: string) => ({
			name: "same_name_tool",
			label,
			description: `${label} description`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: label }] }),
		});
		// 我们（非 replaceable）与「将来的官方内置」（replaceable）注册同名工具
		const ours = {
			name: "ours",
			factory: (pi: { registerTool: (tool: unknown) => void }) => pi.registerTool(sameNameTool("ours")),
		};
		const official = {
			name: "official",
			replaceable: true,
			factory: (pi: { registerTool: (tool: unknown) => void }) => pi.registerTool(sameNameTool("official")),
		};

		const run = async (factories: unknown[]) => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: factories as never,
			});
			await loader.reload();
			const { session, extensionsResult } = await createAgentSession({
				cwd,
				agentDir,
				sessionManager: SessionManager.create(cwd, join(root, "sessions")),
				settingsManager: SettingsManager.create(cwd, agentDir),
				resourceLoader: loader,
			});
			try {
				const winner = session.getAllTools().find((t) => t.name === "same_name_tool");
				return { winner: winner?.description, loaded: extensionsResult.extensions.map((e) => e.path) };
			} finally {
				session.dispose();
			}
		};

		const oursFirst = await run([ours, official]);
		expect(oursFirst.winner).toContain("ours");
		// 官方那份 replaceable → 被 omitReplacedExtensions 整个略过（与我们排第几无关）
		expect(oursFirst.loaded).toEqual(["<inline:ours>"]);
		const officialFirst = await run([official, ours]);
		expect(officialFirst.winner).toContain("ours");
		expect(officialFirst.loaded).toEqual(["<inline:ours>"]);

		// 顺序真正起作用的是「双方都非 replaceable」时（第三方盘上扩展就是这种）：先注册者赢
		const other = {
			name: "other",
			factory: (pi: { registerTool: (tool: unknown) => void }) => pi.registerTool(sameNameTool("other")),
		};
		const oursBeforeOther = await run([ours, other]);
		expect(oursBeforeOther.winner).toContain("ours");
		const otherBeforeOurs = await run([other, ours]);
		expect(otherBeforeOurs.winner).toContain("other");
	});
});
