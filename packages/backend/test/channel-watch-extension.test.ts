import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWakeMessage, makeChannelWatchExtension } from "../src/tools/channel-watch/extension";
import { formatPostEntry } from "../src/tools/channel-watch/post";
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
			"channel_post",
			"channel_subscribe",
			"channel_unsubscribe",
		]);
		const r = await subscribe(pi, "t1");
		expect(r.content[0]?.text).toContain("订阅失败");
	});

	it("订阅 → appendEntry → 对端写 MESSAGES.md → 唤醒模板消息；非 MESSAGES 文件静默（spec channel-post）", async () => {
		const cwd = join(testRoot, "happy");
		const { pi } = await wire({ cwd });
		const r = await subscribe(pi, "t1");
		expect(r.content[0]?.text).toContain("已订阅频道 [t1]");
		expect(pi.appended.at(-1)).toEqual({ customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: ["t1"] } });
		// init 已建目录
		await mkdir(join(cwd, ".local/agent-work/channel/t1"), { recursive: true });
		// 写文件 ≠ 通知：非 MESSAGES 文件静默（多文件写入不再产生多条唤醒）
		await writeFile(join(cwd, ".local/agent-work/channel/t1/IMPL-NOTES.md"), "v1\n");
		await sleep(3900); // 防抖 3s + 余量
		expect(pi.wakes).toHaveLength(0);
		// 另一会话 post（模拟对端写 MESSAGES.md，不经本会话 tool_call → 非自写）
		const mf = join(cwd, ".local/agent-work/channel/t1/MESSAGES.md");
		await writeFile(mf, "## 2026-08-25 10:00 · abc\n\nhi\n\n---\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(1);
		expect(pi.wakes[0]).toMatch(
			/^\[channel:t1\] 有新消息（\d{2}:\d{2}:\d{2}），请读 \.local\/agent-work\/channel\/t1\/MESSAGES\.md 查收。$/,
		);
		// 同内容再写 → hash 未变 → 不再唤醒
		await writeFile(mf, "## 2026-08-25 10:00 · abc\n\nhi\n\n---\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(1);
		// 内容变化（新消息 append）→ 再唤醒
		await appendFile(mf, "## 2026-08-25 10:01 · abc\n\nsecond\n\n---\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(2);
	}, 60_000);

	it("自写抑制：本会话 write MESSAGES.md 目标在窗口内不唤醒", async () => {
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
				input: { path: join(cwd, ".local/agent-work/channel/t1/MESSAGES.md"), content: "x" },
			},
			makeFakeCtx(),
		);
		// 紧接着文件真的被写入（同一目标）
		await writeFile(join(cwd, ".local/agent-work/channel/t1/MESSAGES.md"), "x");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(0);
	}, 60_000);

	it("触发收窄：bash 旁路写非 MESSAGES 文件全程静默（写文件 ≠ 通知，不产生自唤醒）", async () => {
		const cwd = join(testRoot, "bashbypass");
		const { pi } = await wire({ cwd });
		await subscribe(pi, "t1");
		await mkdir(join(cwd, ".local/agent-work/channel/t1"), { recursive: true });
		const f = join(cwd, ".local/agent-work/channel/t1/LOG.md");
		// bash 旁路：会话内用 bash 写频道文件（tool_call 只标 write/edit，bash 不进自写窗口）
		// spec channel-post 后：非 MESSAGES 文件根本不投递，旁路自唤醒问题消失
		await writeFile(f, "echo via-bash v1\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(0);
		await writeFile(f, "echo via-bash v2\n");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(0);
	}, 60_000);

	it("退订 → 空订阅停 watcher；resume 场景恢复订阅集", async () => {
		const cwd = join(testRoot, "unsub");
		const { pi } = await wire({ cwd });
		await subscribe(pi, "t1");
		const unsub = pi.tools.find((t) => t.name === "channel_unsubscribe");
		await unsub?.execute("tc2", { topic: "t1" });
		expect(pi.appended.at(-1)).toEqual({ customType: SUBSCRIPTION_CUSTOM_TYPE, data: { topics: [] } });
		// 对端 post 也不唤醒（无订阅）
		await mkdir(join(cwd, ".local/agent-work/channel/t1"), { recursive: true });
		await writeFile(join(cwd, ".local/agent-work/channel/t1/MESSAGES.md"), "## t\n\nx\n\n---\n");
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
		await writeFile(join(cwd, ".local/agent-work/channel/t1/MESSAGES.md"), "## t\n\nv1\n\n---\n");
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
			await writeFile(join(dir, "MESSAGES.md"), `v${i}\n`);
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
			await writeFile(join(dir, "MESSAGES.md"), `v${i}\n`);
			await sleep(3900);
		}
		expect(pi.wakes).toHaveLength(3);
		// 真人消息（source 非 extension）→ 计数清零
		await pi.emit({ type: "input", text: "用户说话了", source: "interactive" }, makeFakeCtx());
		// 再 3 次不会到 6
		for (let i = 3; i < 6; i++) {
			await writeFile(join(dir, "MESSAGES.md"), `v${i}\n`);
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
	it("模板格式（HH:MM:SS）", () => {
		const msg = buildWakeMessage("t1", new Date(2026, 0, 1, 9, 5));
		expect(msg).toBe(
			"[channel:t1] 有新消息（09:05:00），请读 .local/agent-work/channel/t1/MESSAGES.md 查收。",
		);
	});
});

describe("makeChannelTools 参数 schema", () => {
	it("拍平单 object，无顶层 anyOf", () => {
		const deps = {
			cwd: "/x",
			subscribe: () => ({ ok: true }),
			unsubscribe: () => ({ ok: true }),
			post: async () => ({ ok: true }),
			getSubscriptions: () => new Set<string>(),
			pausedTopics: () => [],
		};
		for (const tool of makeChannelTools(deps)) {
			const params = (tool as { parameters: { anyOf?: unknown } }).parameters;
			expect(params.anyOf).toBeUndefined();
		}
	});
});

describe("formatPostEntry（post.ts 纯函数）", () => {
	it("条目格式：时间戳（精确到秒） + 来源会话前 8 位 + 正文 + 分隔线；closed 带 [CLOSED]", () => {
		const at = new Date(2026, 7, 25, 14, 32, 7);
		expect(formatPostEntry({ topic: "t1", message: "hello\nworld", sessionId: "abcdef123456", at })).toBe(
			"## 2026-08-25 14:32:07 · abcdef12\n\nhello\nworld\n\n---\n",
		);
		// closed 且无 sessionId：标题 = 时间 + [CLOSED]
		expect(formatPostEntry({ topic: "t1", message: "done", closed: true, at })).toBe(
			"## 2026-08-25 14:32:07 · [CLOSED]\n\ndone\n\n---\n",
		);
		// 正文尾部空白规整（不累积空行）
		expect(formatPostEntry({ topic: "t1", message: "x\n\n\n", at })).toBe(
			"## 2026-08-25 14:32:07\n\nx\n\n---\n",
		);
	});
});

describe("channel_post", () => {
	function findPost(pi: ReturnType<typeof makeFakePi>) {
		const tool = pi.tools.find((t) => t.name === "channel_post");
		if (!tool) throw new Error("channel_post 未注册");
		return tool;
	}

	it("两会话联动：A post → 同 cwd 已订阅的 B 收一条唤醒，未订阅的 A 不醋；MESSAGES.md 落盘正确", async () => {
		const cwd = join(testRoot, "duo");
		const a = await wire({ cwd }); // 会话 A：不订阅，只发
		const b = await wire({ cwd }); // 会话 B：订阅 t1
		await subscribe(b.pi, "t1");
		const r = (await findPost(a.pi).execute("tc-p1", {
			topic: "t1",
			message: "进展同步：阶段 1 完成",
		})) as { content: Array<{ type: "text"; text: string }> };
		expect(r.content[0]?.text).toContain("已发送到频道 [t1]");
		// 落盘：目录自动建 + 条目含来源会话 id（fake getSessionId = "s-test"）
		const content = await readFile(join(cwd, ".local/agent-work/channel/t1/MESSAGES.md"), "utf8");
		expect(content).toContain("进展同步：阶段 1 完成");
		expect(content).toContain("s-test");
		expect(content).not.toContain("[CLOSED]");
		await sleep(3900);
		expect(b.pi.wakes).toHaveLength(1);
		expect(b.pi.wakes[0]).toContain("[channel:t1] 有新消息");
		expect(a.pi.wakes).toHaveLength(0);
	}, 60_000);

	it("自订阅频道自 post：markSelfWrite 抑制自我唤醒（消息照常落盘）", async () => {
		const cwd = join(testRoot, "selfpost");
		const { pi } = await wire({ cwd });
		await subscribe(pi, "t1");
		const r = (await findPost(pi).execute("tc-p2", { topic: "t1", message: "给自己的备注" })) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(r.content[0]?.text).toContain("已发送到频道 [t1]");
		const content = await readFile(join(cwd, ".local/agent-work/channel/t1/MESSAGES.md"), "utf8");
		expect(content).toContain("给自己的备注");
		await sleep(3900);
		expect(pi.wakes).toHaveLength(0);
	}, 60_000);

	it("closed 终态：条目标记 [CLOSED] + 返回文案提示退订", async () => {
		const cwd = join(testRoot, "closed");
		const { pi } = await wire({ cwd });
		const r = (await findPost(pi).execute("tc-p3", {
			topic: "t1",
			message: "验收通过，频道关闭",
			closed: true,
		})) as { content: Array<{ type: "text"; text: string }> };
		expect(r.content[0]?.text).toContain("[CLOSED]");
		expect(r.content[0]?.text).toContain("退订");
		const content = await readFile(join(cwd, ".local/agent-work/channel/t1/MESSAGES.md"), "utf8");
		expect(content).toContain("[CLOSED]");
	}, 60_000);

	it("参数拒绝：空消息 / 非法 topic / 非 trusted", async () => {
		const cwd = join(testRoot, "post-reject");
		const { pi } = await wire({ cwd });
		const empty = (await findPost(pi).execute("tc-p4", { topic: "t1", message: "   " })) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(empty.content[0]?.text).toContain("message 不能为空");
		const bad = (await findPost(pi).execute("tc-p5", { topic: "../x", message: "hi" })) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(bad.content[0]?.text).toContain("发送失败");
		const untrusted = await wire({ cwd: join(testRoot, "post-untrusted"), trusted: false });
		const r = (await findPost(untrusted.pi).execute("tc-p6", { topic: "t1", message: "hi" })) as {
			content: Array<{ type: "text"; text: string }>;
		};
		expect(r.content[0]?.text).toContain("发送失败");
		expect(r.content[0]?.text).toContain("受信任");
	}, 60_000);
});
