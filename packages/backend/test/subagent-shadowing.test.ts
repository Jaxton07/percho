import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionGate } from "../src/permissions/gate";
import type { SessionTraces } from "../src/session/traces";
import { makeSubagentTool } from "../src/tools/subagent";
import { applySubagentMutex } from "../src/tools/subagent/mutex";

/**
 * 互斥的 SDK 语义断言（真实 createAgentSession，无 LLM 调用）：
 * 同名 customTool 覆盖扩展工具（Map.set 顺序）+ applySubagentMutex 停用 subagent_* 家族工具。
 * SDK 升级时若覆盖语义变化，本测试会先红。
 */

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function thirdPartySubagentExtension() {
	return {
		name: "fake-pi-subagents",
		factory: (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "subagent",
				label: "ThirdPartySubagent",
				description: "third-party fake subagent tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text" as const, text: "fake" }] }),
			});
			pi.registerTool({
				name: "subagent_wait",
				label: "ThirdPartyWait",
				description: "third-party fake wait tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text" as const, text: "fake" }] }),
			});
		},
	};
}

describe("subagent tool shadowing（真实 SDK 语义）", () => {
	it("内置 customTool 覆盖同名扩展工具，mutex 停用家族工具", async () => {
		const root = await mkdtemp(join(tmpdir(), "percho-subagent-shadow-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [thirdPartySubagentExtension()],
		});
		// DefaultResourceLoader 需显式 reload 才会跑 extensionFactories（对齐冒烟脚本与 projectLoader.load 行为）
		await resourceLoader.reload();
		const builtinTool = makeSubagentTool({
			getModelRuntime: () => Promise.reject(new Error("not needed in test")),
			gate: { confirm: () => Promise.resolve(false) } as unknown as PermissionGate,
			traces: {
				record: () => undefined,
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
			} as unknown as SessionTraces,
		});
		const { session, extensionsResult } = await createAgentSession({
			cwd,
			agentDir,
			customTools: [builtinTool],
			sessionManager: SessionManager.create(cwd, join(root, "sessions")),
			settingsManager: SettingsManager.create(cwd, agentDir),
			resourceLoader,
		});
		try {
			// 同名冲突：激活工具里的 subagent 必须是内置定义（customTools 后写覆盖）
			const subagentInfo = session.getAllTools().find((tool) => tool.name === "subagent");
			expect(subagentInfo?.description).toBe(builtinTool.description);
			expect(session.getActiveToolNames()).toContain("subagent");

			// mutex：subagent 保留（内置），subagent_wait 停用，shadowed 记录扩展路径
			const mutex = applySubagentMutex(session, extensionsResult, true);
			expect(mutex.shadowed).toHaveLength(1);
			expect(mutex.disabledToolNames).toEqual(["subagent_wait"]);
			expect(session.getActiveToolNames()).not.toContain("subagent_wait");
			expect(session.getActiveToolNames()).toContain("subagent");
			expect(session.getAllTools().find((tool) => tool.name === "subagent")?.description).toBe(
				builtinTool.description,
			);
		} finally {
			session.dispose();
		}
	});
});
