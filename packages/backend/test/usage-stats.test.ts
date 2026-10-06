import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

/**
 * 用量/成本口径（spec §5.8）：`usage` entry（`kind: "cache_warm"` 这类**未知 kind 也算**）要计入
 * 会话用量与成本。1.0.4 的 `AgentSession.getSessionStats()` 里 `if (entry.type === "usage")` 直接
 * 累加（任何 kind）—— 这里锁住这条行为，防上游改动 / 我们换算法时漏掉 cache_warm。
 */
describe("usage entry 计入会话统计", () => {
	it("cache_warm 的 usage 进 getSessionStats（非零、且与普通 usage 相加）", async () => {
		const root = mkdtempSync(join(tmpdir(), "percho-usage-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.create(cwd, join(root, "sessions")),
			settingsManager: SettingsManager.create(cwd, agentDir),
			resourceLoader,
		});
		try {
			const usage = {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			};
			// SDK 形状：stats.tokens.{input,output,cacheRead,cacheWrite,total} + cost
			const before = session.getSessionStats().tokens.input;

			session.sessionManager.appendUsage("cache_warm", "test", "test-model", usage);
			session.sessionManager.appendUsage("regular", "test", "test-model", usage);

			const after = session.getSessionStats().tokens.input;
			// 两条都算进来（未知 kind 与普通 kind 一视同仁）
			expect(after - before).toBe(200);
		} finally {
			session.dispose();
		}
	});
});
