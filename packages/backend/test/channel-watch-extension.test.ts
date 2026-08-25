import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWakeMessage, makeChannelWatchExtension } from "../src/tools/channel-watch/extension";
import {
	buildSubsPayload,
	restoreSubscriptions,
	SUBSCRIPTION_CUSTOM_TYPE,
} from "../src/tools/channel-watch/subscriptions";
import { makeChannelTools } from "../src/tools/channel-watch/tools";

/** 假 pi：记录 handler / 工具注册 / appendEntry / 唤醒消息 */
function makeFakePi() {
	const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
	const appended: Array<{ customType: string; data: unknown }> = [];
	const wakes: string[] = [];
	return {
		handlers,
		tools,
		appended,
		wakes,
		on(event: string, handler: (event: never, ctx: never) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) {
			tools.push(tool);
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
		sendUserMessage(text: string) {
			wakes.push(text);
		},
		async emit(event: { type: string }, ctx: unknown) {
			const list = handlers.get(event.type) ?? [];
			for (const handler of list) await (handler as (e: unknown, c: unknown) => unknown)(event, ctx);
		},
	};
}

function makeFakeCtx(entries: unknown[] = [], trusted = true) {
	return {
		sessionManager: {
			getSessionFile: () => "/tmp/s.jsonl",
			getSessionId: () => "s-test",
			getEntries: () => entries,
		},
		isProjectTrusted: () => trusted,
		ui: { notify: (_t: string, _s: string) => {} },
	};
}

let testRoot: string;
let agentDir: string;
const notifications: string[] = [];

beforeAll(async () => {
	testRoot = await mkdtemp(join(tmpdir(), "cw-ext-"));
	agentDir = join(testRoot, "agent");
	await mkdir(agentDir, { recursive: true });
});

afterAll(async () => {
	await rm(testRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function wire(opts: { cwd: string; trusted?: boolean; entries?: unknown[]; enabled?: boolean }) {
	const pi = makeFakePi();
	const ext = makeChannelWatchExtension({
		agentDir,
		cwd: opts.cwd,
		isEnabled: () => opts.enabled ?? true,
		notify: (t) => notifications.push(t),
	});
	(ext as { factory: (pi: unknown) => void }).factory(pi);
	const ctx = makeFakeCtx(opts.entries ?? [], opts.trusted ?? true);
	await pi.emit({ type: "session_start" }, ctx);
	return { pi };
}

/** 订阅（经工具 execute 全链路） */
async function subscribe(pi: ReturnType<typeof makeFakePi>, topic: string) {
	const tool = pi.tools.find((t) => t.name === "channel_subscribe");
	if (!tool) throw new Error("channel_subscribe 未注册");
	return (await tool.execute("tc1", { topic })) as { content: Array<{ type: "text"; text: string }> };
}

describe("subscriptions 持久化", () => {
	it("buildSubsPayload / restoreSubscriptions 往返；多条 entry last-wins（最后一条整体覆盖）", () => {
		const payload1 = buildSubsPayload(["b", "a"]);
		expect(payload1).toEqual({ topics: ["a", "b"] });
		const entries = [
			{ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE, data: payload1 },
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: ["c"] } },
		];
		expect(restoreSubscriptions(entries)).toEqual(new Set(["c"]));
	});

	it("幽灵复活回归：退订后 append 空集合，resume 恢复必须为空（并集会让退订的频道复活）", () => {
		const entries = [
			{ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: ["t1"] } },
			{ type: "message", message: { role: "user", content: "干活" } },
			{ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: [] } }, // 退订 append 的全量快照
		];
		expect(restoreSubscriptions(entries)).toEqual(new Set());
	});

	it("中途非法 entry 跳过，不覆盖先前有效快照", () => {
		const entries = [
			{ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: ["t1"] } },
			{ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE }, // data 缺失 → 跳过
		];
		expect(restoreSubscriptions(entries)).toEqual(new Set(["t1"]));
	});

	it("容错：非数组 / 其他 customType / 空 data", () => {
		expect(restoreSubscriptions(null)).toEqual(new Set());
		expect(restoreSubscriptions([{ type: "custom", customType: "other", data: {} }])).toEqual(new Set());
		expect(restoreSubscriptions([{ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE }])).toEqual(
			new Set(),
		);
	});
});

describe("extension 全链路", () => {
	it("开关关：session_start 零副作用（不注册工具、不 init）", async () => {
		const cwd = join(testRoot, "off");
		const { pi } = await wire({ cwd, enabled: false });
		expect(pi.tools).toHaveLength(0);
		expect(pi.appended).toHaveLength(0);
	});

	it("非 trusted：不 init 目录，subscribe 被拒", async () => {
		const cwd = join(testRoot, "untrusted");
		const { pi } = await wire({ cwd, trusted: false });
		expect(pi.tools.map((t) => t.name).sort()).toEqual([
			"channel_list",
			"channel_subscribe",
			"channel_unsubscribe",
		]);
		const r = await subscribe(pi, "t1");
		expect(r.content[0]?.text).toContain("订阅失败");
	});

	it("订阅 → appendEntry → 另一写入者改文件 → 唤醒模板消息（防抖后）", async () => {
		const cwd = join(testRoot, "happy");
		const { pi } = await wire({ cwd });
		const r = await subscribe(pi, "t1");
		expect(r.content[0]?.text).toContain("已订阅频道 [t1]");
		expect(pi.appended.at(-1)).toEqual({ customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: ["t1"] } });
		// init 已建目录
		await mkdir(join(cwd, ".local/agent-work/channel/t1"), { recursive: true });
		// 另一会话写文件（不经本会话 tool_call → 非自写）
		await writeFile(join(cwd, ".local/agent-work/channel/t1/IMPL-NOTES.md"), "v1\n");
		await sleep(3900); // 防抖 3s + 余量
		expect(pi.wakes).toHaveLength(1);
		expect(pi.wakes[0]).toMatch(
			/^\[channel:t1\] IMPL-NOTES\.md 有更新（\d{2}:\d{2}），请按 \.local\/agent-work\/channel\/t1\/HANDOFF\.md 的沟通协议查收。$/,
		);
		// 同内容再写 → hash 未变 → 不再唤醒
		await writeFile(join(cwd, ".local/agent-work/channel/t1/IMPL-NOTES.md"), "v1\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(1);
		// 内容变化 → 再唤醒
		await writeFile(join(cwd, ".local/agent-work/channel/t1/IMPL-NOTES.md"), "v2 content changed\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(2);
	}, 60_000);

	it("自写抑制：tool_call write 目标在窗口内不唤醒", async () => {
		const cwd = join(testRoot, "selfwrite");
		const { pi } = await wire({ cwd });
		await subscribe(pi, "t1");
		await mkdir(join(cwd, ".local/agent-work/channel/t1"), { recursive: true });
		// 模拟本会话 write 工具调用（tool_call 事件）
		await pi.emit(
			{
				type: "tool_call",
				toolName: "write",
				toolCallId: "tc9",
				input: { path: join(cwd, ".local/agent-work/channel/t1/A.md"), content: "x" },
			},
			makeFakeCtx(),
		);
		// 紧接着文件真的被写入（同一目标）
		await writeFile(join(cwd, ".local/agent-work/channel/t1/A.md"), "x");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(0);
	}, 60_000);

	it("bash 旁路补测（review 验收项）：不经 tool_call 的写入产生至多一条自唤醒，同内容重复写被 hash 兜住", async () => {
		const cwd = join(testRoot, "bashbypass");
		const { pi } = await wire({ cwd });
		await subscribe(pi, "t1");
		await mkdir(join(cwd, ".local/agent-work/channel/t1"), { recursive: true });
		const f = join(cwd, ".local/agent-work/channel/t1/LOG.md");
		// bash 旁路：会话内用 bash 写频道文件（tool_call 只标 write/edit，bash 不进自写窗口）
		await writeFile(f, "echo via-bash v1\n");
		await sleep(3900);
		// 实际行为（与 review 代码走读一致）：hash 层兜不住「内容真变化的自写」→ 一条自唤醒
		expect(pi.wakes).toHaveLength(1);
		// 同内容再写（mtime 变、hash 同）→ hash 去重兜住，不再唤醒
		await writeFile(f, "echo via-bash v1\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(1);
		// 再变内容 → 又一条自唤醒（由「不写回纪律 + 乒乓上限 6/10min」收尾，非 hash 层）
		await writeFile(f, "echo via-bash v2\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(2);
	}, 60_000);

	it("退订 → 空订阅停 watcher；resume 场景恢复订阅集", async () => {
		const cwd = join(testRoot, "unsub");
		const { pi } = await wire({ cwd });
		await subscribe(pi, "t1");
		const unsub = pi.tools.find((t) => t.name === "channel_unsubscribe");
		await unsub?.execute("tc2", { topic: "t1" });
		expect(pi.appended.at(-1)).toEqual({ customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: [] } });
		// 写文件不唤醒（无订阅）
		await mkdir(join(cwd, ".local/agent-work/channel/t1"), { recursive: true });
		await writeFile(join(cwd, ".local/agent-work/channel/t1/B.md"), "x");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(0);
	}, 60_000);

	it("session_start 恢复订阅并自动监听", async () => {
		const cwd = join(testRoot, "resume");
		const entries = [{ type: "custom", customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: ["t1"] } }];
		const { pi } = await wire({ cwd, entries });
		const list = pi.tools.find((t) => t.name === "channel_list");
		const r = (await list?.execute("tc3", {})) as { content: Array<{ type: "text"; text: string }> };
		expect(r.content[0]?.text).toContain("t1：已订阅");
		await mkdir(join(cwd, ".local/agent-work/channel/t1"), { recursive: true });
		await writeFile(join(cwd, ".local/agent-work/channel/t1/C.md"), "v1");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(1);
	}, 60_000);

	it("乒乓上限：连续唤醒 6 次后暂停 + notify", async () => {
		const cwd = join(testRoot, "pingpong");
		const { pi } = await wire({ cwd });
		await subscribe(pi, "pp");
		const dir = join(cwd, ".local/agent-work/channel/pp");
		await mkdir(dir, { recursive: true });
		const before = notifications.length;
		for (let i = 0; i < 8; i++) {
			await writeFile(join(dir, "F.md"), `v${i}\n`);
			await sleep(3900);
		}
		// 前 5 次投递 + 第 6 次触发暂停（投递后计数）→ 总投递 6 次，后续 2 次被暂停拦截
		expect(pi.wakes.length).toBe(6);
		expect(notifications.slice(before).some((t) => t.includes("互触发达到上限"))).toBe(true);
		const list = pi.tools.find((t) => t.name === "channel_list");
		const r = (await list?.execute("tc4", {})) as { content: Array<{ type: "text"; text: string }> };
		expect(r.content[0]?.text).toContain("⚠️已暂停");
		// 重新订阅恢复
		await subscribe(pi, "pp");
		const r2 = (await list?.execute("tc5", {})) as { content: Array<{ type: "text"; text: string }> };
		expect(r2.content[0]?.text).not.toContain("⚠️已暂停");
	}, 60_000);

	it("真人输入介入清零乒乓计数（input 事件）", async () => {
		const cwd = join(testRoot, "userinput");
		const { pi } = await wire({ cwd });
		await subscribe(pi, "t1");
		const dir = join(cwd, ".local/agent-work/channel/t1");
		await mkdir(dir, { recursive: true });
		for (let i = 0; i < 3; i++) {
			await writeFile(join(dir, "G.md"), `v${i}\n`);
			await sleep(3900);
		}
		expect(pi.wakes).toHaveLength(3);
		// 真人消息（source 非 extension）→ 计数清零
		await pi.emit({ type: "input", text: "用户说话了", source: "interactive" }, makeFakeCtx());
		// 再 3 次不会到 6
		for (let i = 3; i < 6; i++) {
			await writeFile(join(dir, "G.md"), `v${i}\n`);
			await sleep(3900);
		}
		expect(pi.wakes).toHaveLength(6); // 无暂停，全部投递
		const list = pi.tools.find((t) => t.name === "channel_list");
		const r = (await list?.execute("tc6", {})) as { content: Array<{ type: "text"; text: string }> };
		expect(r.content[0]?.text).not.toContain("⚠️已暂停");
		// 扩展注入（source=extension）不清零
	}, 60_000);
});

describe("buildWakeMessage", () => {
	it("模板格式（HH:MM）", () => {
		const msg = buildWakeMessage("t1", "t1/IMPL-NOTES.md", new Date(2026, 0, 1, 9, 5));
		expect(msg).toBe(
			"[channel:t1] IMPL-NOTES.md 有更新（09:05），请按 .local/agent-work/channel/t1/HANDOFF.md 的沟通协议查收。",
		);
	});
});

describe("makeChannelTools 参数 schema", () => {
	it("拍平单 object，无顶层 anyOf", () => {
		const deps = {
			cwd: "/x",
			subscribe: () => ({ ok: true }),
			unsubscribe: () => ({ ok: true }),
			getSubscriptions: () => new Set<string>(),
			pausedTopics: () => [],
		};
		for (const tool of makeChannelTools(deps)) {
			const params = (tool as { parameters: { anyOf?: unknown } }).parameters;
			expect(params.anyOf).toBeUndefined();
		}
	});
});
