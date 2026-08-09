import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makePermissionGateExtension } from "../src/permission-extension";
import { PermissionGate } from "../src/permissions";

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-perm-ext-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 挂载扩展并返回 tool_call 触发器；confirmAnswer 控制弹窗结果 */
function makeHarness(
	agentDir: string,
	confirmAnswer: boolean | ((title: string) => boolean) = false,
	options?: { projectRoot?: string },
) {
	const extension = makePermissionGateExtension(agentDir, options);
	if (typeof extension === "function" || !("factory" in extension)) {
		throw new Error("expected named inline extension");
	}
	let handler: ToolCallHandler | undefined;
	const pi = {
		on: (event: string, h: ToolCallHandler) => {
			if (event === "tool_call") handler = h;
		},
	};
	extension.factory(pi as unknown as ExtensionAPI);
	if (!handler) throw new Error("tool_call handler not registered");

	const confirms: { title: string; message: string }[] = [];
	const ctx = {
		ui: {
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return typeof confirmAnswer === "function" ? confirmAnswer(title) : confirmAnswer;
			},
		},
	} as unknown as ExtensionContext;

	const call = (toolName: string, input: Record<string, unknown>) =>
		handler({ type: "tool_call", toolCallId: "tc-1", toolName, input } as ToolCallEvent, ctx);
	return { call, confirms };
}

describe("permission-gate 扩展", () => {
	it("默认规则：普通 bash/文件工具直接放行，不弹窗", async () => {
		const { call, confirms } = makeHarness(makeAgentDir());
		await expect(call("bash", { command: "npm test" })).resolves.toBeUndefined();
		await expect(call("edit", { path: "/tmp/a.ts" })).resolves.toBeUndefined();
		expect(confirms).toHaveLength(0);
	});

	it("高危命令弹窗；用户允许则放行", async () => {
		const { call, confirms } = makeHarness(makeAgentDir(), true);
		await expect(call("bash", { command: "rm -rf /tmp/x" })).resolves.toBeUndefined();
		expect(confirms).toHaveLength(1);
		expect(confirms[0].title).toBe("bash: rm -rf*");
		expect(confirms[0].message).toBe("rm -rf /tmp/x");
	});

	it("高危命令弹窗；用户拒绝则 block 并给 LLM reason", async () => {
		const { call } = makeHarness(makeAgentDir(), false);
		const result = await call("bash", { command: "sudo rm -rf /" });
		expect(result).toMatchObject({ block: true });
		expect((result as ToolCallEventResult).reason).toContain("denied");
	});

	it("命令链中藏高危命令同样弹窗；标题定位危险段", async () => {
		const { call, confirms } = makeHarness(makeAgentDir(), false);
		const result = await call("bash", { command: "cd /tmp && ls && rm -rf xxx" });
		expect(result).toMatchObject({ block: true });
		expect((result as ToolCallEventResult).reason).toContain("denied");
		expect(confirms).toHaveLength(1);
		expect(confirms[0].title).toBe("bash: rm -rf*");
		expect(confirms[0].message).toBe("cd /tmp && ls && rm -rf xxx");
	});

	it("deny 规则直接 block，不弹窗", async () => {
		const dir = makeAgentDir();
		writeFileSync(
			join(dir, "permissions.json"),
			JSON.stringify({ rules: { bash: { "*": "allow", "git push *": "deny" } } }),
		);
		const { call, confirms } = makeHarness(dir, true);
		const result = await call("bash", { command: "git push origin main" });
		expect(result).toMatchObject({ block: true });
		expect((result as ToolCallEventResult).reason).toContain("permission rule");
		expect(confirms).toHaveLength(0);
	});

	it("enabled=false 整体放行", async () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ enabled: false }));
		const { call, confirms } = makeHarness(dir, false);
		await expect(call("bash", { command: "rm -rf /" })).resolves.toBeUndefined();
		expect(confirms).toHaveLength(0);
	});

	it("项目边界：根外路径弹窗（含 ../../ 相对逃逸），根内与不设边界放行", async () => {
		const dir = makeAgentDir();
		const root = join(dir, "proj");
		mkdirSync(root, { recursive: true });
		const { call, confirms } = makeHarness(dir, false, { projectRoot: root });
		// 根内绝对/相对路径直接放行
		await expect(call("edit", { path: join(root, "a.ts") })).resolves.toBeUndefined();
		await expect(call("read", { path: "src/b.ts" })).resolves.toBeUndefined();
		// 根外绝对路径与 ../../ 相对逃逸都弹窗（confirmAnswer=false → block）
		await expect(call("edit", { path: "/etc/hosts" })).resolves.toMatchObject({ block: true });
		await expect(call("write", { path: "../../escape.ts" })).resolves.toMatchObject({ block: true });
		expect(confirms.map((c) => c.title)).toEqual(["edit: /etc/hosts", "write: ../../escape.ts"]);
		// 不传 projectRoot → 无边界检查，任意路径放行
		const open = makeHarness(dir, false);
		await expect(open.call("edit", { path: "/etc/hosts" })).resolves.toBeUndefined();
		// bash 无法路径约束，不受边界影响
		await expect(call("bash", { command: "ls /etc" })).resolves.toBeUndefined();
	});

	it("自定义工具吃工具名级规则", async () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ rules: { my_tool: "deny" } }));
		const { call } = makeHarness(dir);
		await expect(call("my_tool", { foo: 1 })).resolves.toMatchObject({ block: true });
		await expect(call("other_tool", { foo: 1 })).resolves.toBeUndefined();
	});

	it("ask 走 PermissionGate：allowAlways 后同模式不再弹窗", async () => {
		const dir = makeAgentDir();
		writeFileSync(
			join(dir, "permissions.json"),
			JSON.stringify({ rules: { bash: { "*": "ask", "git *": "allow" } } }),
		);
		const extension = makePermissionGateExtension(dir);
		if (typeof extension === "function" || !("factory" in extension)) throw new Error("unexpected");
		let handler: ToolCallHandler | undefined;
		extension.factory({
			on: (_event: string, h: ToolCallHandler) => {
				handler = h;
			},
		} as unknown as ExtensionAPI);

		const confirms: string[] = [];
		const gate = new PermissionGate((req) => {
			confirms.push(req.title);
			queueMicrotask(() => gate.respond(req.id, "allowAlways"));
		});
		gate.bindSession("s1");
		const ctx = {
			ui: {
				confirm: (title: string, message: string) => gate.confirm(title, message),
			},
		} as unknown as ExtensionContext;
		const call = (command: string) =>
			handler?.(
				{ type: "tool_call", toolCallId: "tc", toolName: "bash", input: { command } } as ToolCallEvent,
				ctx,
			);

		await expect(call("npm test")).resolves.toBeUndefined();
		await expect(call("npm run build")).resolves.toBeUndefined();
		await expect(call("npm test --watch")).resolves.toBeUndefined();
		// npm run build 的模式键不同会再问一次；npm test --watch 命中已记忆的 bash: npm test* 不再问
		expect(confirms).toEqual(["bash: npm test*", "bash: npm run*"]);
	});
});
