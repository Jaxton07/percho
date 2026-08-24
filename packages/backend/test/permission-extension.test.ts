import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makePermissionGateExtension, type PermissionConfirm } from "../src/permissions/extension";
import { PermissionGate } from "../src/permissions/gate";
import { workspaceConfigPath } from "../src/project/workspace-store";

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

interface ConfirmCall {
	title: string;
	message: string;
	kind?: "path" | "command" | "other";
	suggestDir?: string;
}

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-perm-ext-"));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 挂载扩展并返回 tool_call 触发器；confirmAnswer 控制弹窗结果，confirmCalls 捕获元数据；
 * ctx.cwd 缺省 homedir（非临时区基准；临时区豁免测试按需覆盖 cwd） */
function makeHarness(
	agentDir: string,
	confirmAnswer: boolean | ((title: string) => boolean) = false,
	options?: { projectRoot?: string; confirmCalls?: ConfirmCall[]; cwd?: string },
) {
	const confirmCalls = options?.confirmCalls;
	const confirm: PermissionConfirm | undefined = confirmCalls
		? async (title, message, meta) => {
				confirmCalls.push({ title, message, ...meta });
				return typeof confirmAnswer === "function" ? confirmAnswer(title) : confirmAnswer;
			}
		: undefined;
	const extension = makePermissionGateExtension(agentDir, { projectRoot: options?.projectRoot, confirm });
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
		cwd: options?.cwd ?? homedir(),
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
		await expect(call("bash", { command: "rm -rf /etc/perm-x" })).resolves.toBeUndefined();
		expect(confirms).toHaveLength(1);
		expect(confirms[0].title).toBe("bash: rm -rf*");
		expect(confirms[0].message).toBe("rm -rf /etc/perm-x");
	});

	it("高危命令弹窗；用户拒绝则 block 并给 LLM reason", async () => {
		const { call } = makeHarness(makeAgentDir(), false);
		const result = await call("bash", { command: "sudo rm -rf /" });
		expect(result).toMatchObject({ block: true });
		expect((result as ToolCallEventResult).reason).toContain("denied");
	});

	it("命令链中藏高危命令同样弹窗；标题定位危险段", async () => {
		const { call, confirms } = makeHarness(makeAgentDir(), false);
		const result = await call("bash", { command: "cd /tmp && ls && rm -rf /etc/xxx" });
		expect(result).toMatchObject({ block: true });
		expect((result as ToolCallEventResult).reason).toContain("denied");
		expect(confirms).toHaveLength(1);
		expect(confirms[0].title).toBe("bash: rm -rf*");
		expect(confirms[0].message).toBe("cd /tmp && ls && rm -rf /etc/xxx");
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

	it("自保护默认规则：触及权限/凭证配置的 bash 与 edit/write 必确认", async () => {
		const { call, confirms } = makeHarness(makeAgentDir(), false);
		await expect(call("bash", { command: "cat ~/.pi/agent/permissions.json" })).resolves.toMatchObject({
			block: true,
		});
		await expect(call("edit", { path: "/somewhere/auth.json" })).resolves.toMatchObject({ block: true });
		expect(confirms).toHaveLength(2);
	});

	it("项目边界：界外写确认（含 ../../ 相对逃逸），界内与不设边界放行", async () => {
		const dir = makeAgentDir();
		const root = join(dir, "proj");
		mkdirSync(root, { recursive: true });
		const { call, confirms } = makeHarness(dir, false, { projectRoot: root });
		// 根内绝对/相对路径直接放行
		await expect(call("edit", { path: join(root, "a.ts") })).resolves.toBeUndefined();
		await expect(call("read", { path: "src/b.ts" })).resolves.toBeUndefined();
		// 根外绝对路径与相对逃逸都确认（confirmAnswer=false → block）；沙箱在 tmpdir 下，
		// 逃逸深度 +1 才能落出临时区（../../escape.ts 落入 T 根，会被 temporary=allow 豁免）
		await expect(call("edit", { path: "/etc/hosts" })).resolves.toMatchObject({ block: true });
		const escapeResult = await call("write", { path: "../../../escape.ts" });
		expect(escapeResult).toMatchObject({ block: true });
		// 标题 = 记忆模式键（绝对路径的父目录前缀）；../../../escape.ts 相对 root 解析后落在 tmpdir 父目录（区外）
		expect(confirms.map((c) => c.title)).toEqual(["edit: /etc/*", `write: ${join(dirname(dirname(dir)), "*")}`]);
		// 不传 projectRoot → 无边界检查，任意路径放行
		const open = makeHarness(dir, false);
		await expect(open.call("edit", { path: "/etc/hosts" })).resolves.toBeUndefined();
		// bash 无法路径约束，不受边界影响
		await expect(call("bash", { command: "ls /etc" })).resolves.toBeUndefined();
	});

	it("读写分离：界外读默认放行（outside.read=allow）", async () => {
		const dir = makeAgentDir();
		const root = join(dir, "proj");
		mkdirSync(root, { recursive: true });
		const { call, confirms } = makeHarness(dir, false, { projectRoot: root });
		await expect(call("read", { path: "/etc/hosts" })).resolves.toBeUndefined();
		await expect(call("ls", { path: join(dir, "elsewhere") })).resolves.toBeUndefined();
		expect(confirms).toHaveLength(0);
	});

	it("读写分离：outside.read=ask 收紧后界外读确认", async () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ outside: { read: "ask" } }));
		const root = join(dir, "proj");
		mkdirSync(root, { recursive: true });
		const { call, confirms } = makeHarness(dir, false, { projectRoot: root });
		await expect(call("read", { path: "/etc/hosts" })).resolves.toMatchObject({ block: true });
		// 界内读不受影响
		await expect(call("read", { path: join(root, "a.ts") })).resolves.toBeUndefined();
		expect(confirms).toHaveLength(1);
	});

	it("工作区多根：根集合内的路径视为界内直接放行", async () => {
		const dir = makeAgentDir();
		const root = join(dir, "proj");
		const other = join(dir, "other-repo");
		mkdirSync(root, { recursive: true });
		mkdirSync(join(other, "src"), { recursive: true });
		writeFileSync(
			workspaceConfigPath(dir),
			JSON.stringify({ version: 1, projects: { [root]: { roots: [other], allowed: [] } } }),
		);
		const { call, confirms } = makeHarness(dir, false, { projectRoot: root });
		// other 根内读写均放行（界内规则：默认 allow）
		await expect(call("edit", { path: join(other, "src", "a.ts") })).resolves.toBeUndefined();
		await expect(call("read", { path: join(other, "README.md") })).resolves.toBeUndefined();
		// 仍在全部根之外 → 确认
		await expect(call("edit", { path: "/etc/hosts" })).resolves.toMatchObject({ block: true });
		expect(confirms).toHaveLength(1);
	});

	it("项目记忆（allowAlways 持久化）：allowed 模式命中不再弹窗；deny 不可被记忆覆盖", async () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ rules: { bash: { "*": "ask" } } }));
		const root = join(dir, "proj");
		mkdirSync(root, { recursive: true });
		writeFileSync(
			workspaceConfigPath(dir),
			JSON.stringify({
				version: 1,
				projects: { [root]: { roots: [], allowed: ["bash: npm test*", "write: /safe/*"] } },
			}),
		);
		const { call, confirms } = makeHarness(dir, false, { projectRoot: root });
		// 记忆命中（含命令链切段：cd x && npm test 命中 bash: npm test*）
		await expect(call("bash", { command: "npm test" })).resolves.toBeUndefined();
		await expect(call("bash", { command: "cd /tmp && npm test --watch" })).resolves.toBeUndefined();
		// 未记忆的模式仍确认
		await expect(call("bash", { command: "npm run build" })).resolves.toMatchObject({ block: true });
		expect(confirms).toHaveLength(1);
		// 界外写命中目录前缀记忆 → 放行
		await expect(call("write", { path: "/safe/notes.md" })).resolves.toBeUndefined();
		// deny 规则不被记忆覆盖
		writeFileSync(
			join(dir, "permissions.json"),
			JSON.stringify({ rules: { bash: { "*": "ask", "npm test *": "deny" } } }),
		);
		await expect(call("bash", { command: "npm test -- --grep x" })).resolves.toMatchObject({ block: true });
	});

	it("ask 元数据：path 类带 kind/suggestDir（git 根候选）；bash 为 command 无 suggestDir", async () => {
		const dir = makeAgentDir();
		const root = join(dir, "proj");
		// git 根候选 fixture 必须在临时区之外（tmp 路径走 temporary 分支：默认放行不弹窗，
		// 收紧后也不给 suggestDir）；放包目录下临时目录（用后清理），不写用户家目录
		const fixtureBase = mkdtempSync(join(process.cwd(), ".perm-ext-fixture-"));
		const repo = join(fixtureBase, "other-repo");
		mkdirSync(root, { recursive: true });
		mkdirSync(join(repo, "sub"), { recursive: true });
		mkdirSync(join(repo, ".git")); // git 根候选
		try {
			const calls: ConfirmCall[] = [];
			const { call } = makeHarness(dir, false, { projectRoot: root, confirmCalls: calls });
			await call("edit", { path: join(repo, "sub", "a.ts") });
			await call("bash", { command: "rm -rf /etc/perm-x" });
			expect(calls[0]).toMatchObject({ kind: "path", suggestDir: repo });
			expect(calls[1]).toMatchObject({ kind: "command" });
			expect(calls[1].suggestDir).toBeUndefined();
		} finally {
			rmSync(fixtureBase, { recursive: true, force: true });
		}
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

	it("临时区默认放行：write/edit 落 tmp 不弹窗；rm 删 tmp 目标跳过兜底；穿越/混合目标仍确认", async () => {
		const { call, confirms } = makeHarness(makeAgentDir(), false);
		await expect(call("write", { path: `${resolve(tmpdir())}/x.ts` })).resolves.toBeUndefined();
		await expect(call("edit", { path: "/tmp/y.ts" })).resolves.toBeUndefined();
		await expect(call("bash", { command: `rm -rf ${resolve(tmpdir())}/sub/` })).resolves.toBeUndefined();
		await expect(call("bash", { command: "rm -rf /tmp/a /tmp/b" })).resolves.toBeUndefined();
		expect(confirms).toHaveLength(0);
		// 路径穿越与混合目标不被豁免（fail-safe）
		await expect(call("bash", { command: "rm -rf /tmp/../etc/perm-test" })).resolves.toMatchObject({
			block: true,
		});
		await expect(call("bash", { command: "rm -rf /tmp/a /etc/b" })).resolves.toMatchObject({ block: true });
		expect(confirms.map((c) => c.title)).toEqual(["bash: rm -rf*", "bash: rm -rf*"]);
	});

	it("自保护规则不受临时区影响：tmp 下的 permissions.json 写入仍确认（显式 ask 不被放松）", async () => {
		const { call, confirms } = makeHarness(makeAgentDir(), false);
		await expect(call("write", { path: `${resolve(tmpdir())}/permissions.json` })).resolves.toMatchObject({
			block: true,
		});
		expect(confirms).toHaveLength(1);
	});

	it("outside.temporary=ask 收紧：tmp 写与 tmp rm 目标从默认放行变确认", async () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ outside: { temporary: "ask" } }));
		const { call, confirms } = makeHarness(dir, false);
		await expect(call("write", { path: `${resolve(tmpdir())}/x.ts` })).resolves.toMatchObject({
			block: true,
		});
		await expect(call("bash", { command: `rm -rf ${resolve(tmpdir())}/x` })).resolves.toMatchObject({
			block: true,
		});
		expect(confirms.map((c) => c.title)).toEqual([`write: ${resolve(tmpdir())}${sep}*`, "bash: rm -rf*"]);
	});

	it("outside.temporary=deny 收紧：tmp 写走确认（拒→block）；rm tmp 目标在求值层直接 block（deny 地板）", async () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ outside: { temporary: "deny" } }));
		const { call, confirms } = makeHarness(dir, false);
		await expect(call("write", { path: "/tmp/x.ts" })).resolves.toMatchObject({ block: true });
		const rmResult = await call("bash", { command: "rm -rf /tmp/x" });
		expect(rmResult).toMatchObject({ block: true });
		expect((rmResult as ToolCallEventResult).reason).toContain("permission rule");
		expect(confirms).toHaveLength(1); // 只有 write 弹窗；bash 段 deny 地板在 evaluateBashCommand 内生效，不弹窗
	});

	it("用户显式 deny 永不被 temporary=allow 覆盖（rm -rf /tmp/precious* 直接 block 不弹窗）", async () => {
		const dir = makeAgentDir();
		writeFileSync(
			join(dir, "permissions.json"),
			JSON.stringify({ rules: { bash: { "*": "allow", "rm -rf /tmp/precious*": "deny" } } }),
		);
		const { call, confirms } = makeHarness(dir, false);
		const result = await call("bash", { command: "rm -rf /tmp/precious-data" });
		expect(result).toMatchObject({ block: true });
		expect((result as ToolCallEventResult).reason).toContain("permission rule");
		expect(confirms).toHaveLength(0);
	});

	it("projectRoot 本身在临时区：地理优先，按 temporary 语义处置（ask → 确认）", async () => {
		const dir = makeAgentDir();
		writeFileSync(join(dir, "permissions.json"), JSON.stringify({ outside: { temporary: "ask" } }));
		const root = join(dir, "proj"); // 沙箱本身在 tmpdir 下
		const { call, confirms } = makeHarness(dir, false, { projectRoot: root });
		await expect(call("write", { path: join(root, "a.ts") })).resolves.toMatchObject({ block: true });
		expect(confirms).toHaveLength(1);
	});

	it("rm 相对目标按 ctx.cwd resolve：cwd 在临时区 → 豁免；不在 → 确认", async () => {
		const inTmp = makeHarness(makeAgentDir(), false, { cwd: resolve(tmpdir()) });
		await expect(inTmp.call("bash", { command: "rm -rf sub/x" })).resolves.toBeUndefined();
		expect(inTmp.confirms).toHaveLength(0);
		const atHome = makeHarness(makeAgentDir(), false, { cwd: homedir() });
		await expect(atHome.call("bash", { command: "rm -rf sub/x" })).resolves.toMatchObject({ block: true });
		expect(atHome.confirms).toHaveLength(1);
	});
});
