import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	READ_ONLY_GIT_COMMANDS,
	subagentBoundaryViolation,
	subagentPermissionMode,
} from "../src/tools/subagent/policy";
import { describeBoundaries } from "../src/tools/subagent/prompt";

describe("边界提示与执行同源", () => {
	it("路径工具按 SDK 支持的路径写法保护状态目录", () => {
		const root = join(homedir(), ".percho/agent-isolated-test");
		const policy = { agentDir: root, deny: [] };
		for (const path of [
			"~/.percho/agent-isolated-test/auth.json",
			`@${root}/auth.json`,
			pathToFileURL(join(root, "auth.json")).href,
		])
			expect(subagentBoundaryViolation(policy, "write", path, "/project")).toBeTruthy();
		expect(subagentBoundaryViolation(policy, "write", `${root}-other/auth.json`, "/project")).toBeUndefined();
	});
	it("逐项只读 git 放行、deny 拒绝，收紧配置同步反映到文本", () => {
		const policy = { agentDir: "/percho-state", deny: ["bash: npm publish*", "webfetch"] };
		const text = describeBoundaries(policy);
		expect(subagentBoundaryViolation(policy, "bash", '/bin/bash -c "git push"', "/project")).toBeTruthy();
		expect(subagentBoundaryViolation(policy, "bash", "git status --git-dir=x", "/project")).toBeTruthy();
		expect(subagentBoundaryViolation(policy, "bash", 'git status && echo "-C"', "/project")).toBeUndefined();
		for (const name of READ_ONLY_GIT_COMMANDS) {
			expect(text).toContain(name);
			expect(subagentBoundaryViolation(policy, "bash", `git ${name}`, "/project")).toBeUndefined();
		}
		for (const [tool, command] of [
			["bash", "npm publish"],
			["webfetch", null],
			["write", "/percho-state/settings.json"],
			["bash", "git push"],
		] as const)
			expect(subagentBoundaryViolation(policy, tool, command, "/project")).toBeTruthy();
		expect(text).toContain("npm publish*");
		expect(describeBoundaries({ ...policy, permissionMode: "default" })).toContain("limited to default");
	});
	it("权限仅继承或收紧", () => {
		expect(subagentPermissionMode("default", "fullAccess")).toBe("default");
		expect(subagentPermissionMode("fullAccess", "default")).toBe("default");
		expect(subagentPermissionMode("fullAccess")).toBe("fullAccess");
		expect(subagentPermissionMode("default")).toBe("default");
	});
});
