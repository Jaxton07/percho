import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { ChannelSubscriptionRegistry } from "../src/channel-subscriptions";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";

/**
 * 频道订阅快照仓库（spec D1）：只存 topic 名 + (generation, revision) 两把钥匙，
 * 供 renderer 判新旧；GC 查询语义保持与改造前一致（按 registry 过滤）。
 */
// 项目规则：**不碰系统 /tmp**，中间结果放仓库 .local/tmp/<专用前缀>（`.local/` 已 gitignore）
const root = fileURLToPath(new URL("../../../.local/tmp/qol3-channel-subs-test", import.meta.url));
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const topics = (...names: string[]) => new Set(names);

describe("ChannelSubscriptionRegistry · 上报与发布", () => {
	it("内容没变不发布；内容变了发布一次，载荷是去重排序副本", () => {
		const reg = new ChannelSubscriptionRegistry(() => true);
		reg.noteSessionOpened("s1");
		const seen: Array<{ topics: string[]; revision: number; generation: number }> = [];
		reg.subscribe((snapshot) =>
			seen.push({ topics: snapshot.topics, revision: snapshot.revision, generation: snapshot.generation }),
		);
		reg.report("s1", topics("beta", "alpha", "alpha"));
		expect(seen).toEqual([{ topics: ["alpha", "beta"], revision: 1, generation: 1 }]);
		reg.report("s1", topics("alpha", "beta")); // 同内容（顺序不同）
		expect(seen).toHaveLength(1);
		reg.report("s1", topics("alpha"));
		expect(seen).toHaveLength(2);
		expect(seen[1]?.revision).toBe(2);
		expect(seen[1]?.generation).toBe(1); // 同一代内 revision 变、generation 不变
	});

	it("空集 = 移出快照（退订最后一个 topic 就恢复普通 GC 资格）", () => {
		const reg = new ChannelSubscriptionRegistry(() => true);
		reg.report("s1", topics("alpha"));
		expect(reg.snapshot("s1").topics).toEqual(["alpha"]);
		reg.report("s1", topics());
		expect(reg.snapshot("s1").topics).toEqual([]);
		expect(reg.loadedSessionIdsWithSubscriptions()).toEqual([]);
	});

	it("live 字段：在册 true / dispose 后 false / 删除后 false（不再用 topics 空猜生命周期）", () => {
		const reg = new ChannelSubscriptionRegistry(() => true);
		reg.noteSessionOpened("s1");
		expect(reg.snapshot("s1").live).toBe(true); // 有在册实例、暂时没订阅
		reg.report("s1", topics("alpha"));
		expect(reg.snapshot("s1").live).toBe(true);
		reg.report("s1", topics()); // 退订：仍是 live（只是没订阅）
		expect(reg.snapshot("s1")).toMatchObject({ live: true, topics: [] });
		reg.dispose("s1");
		expect(reg.snapshot("s1")).toMatchObject({ live: false, topics: [] }); // dispose 才是明确关闭信号
		reg.noteSessionOpened("s1");
		reg.report("s1", topics("beta"));
		reg.delete("s1");
		expect(reg.snapshot("s1")).toMatchObject({ live: false, topics: [], generation: 0 });
	});

	it("事件载荷同样带 live：dispose 事件 live=false，正常上报 live=true", () => {
		const reg = new ChannelSubscriptionRegistry(() => true);
		const seen: Array<{ live: boolean; topics: string[] }> = [];
		reg.subscribe((s) => seen.push({ live: s.live, topics: s.topics }));
		reg.noteSessionOpened("s1");
		reg.report("s1", topics("alpha"));
		reg.dispose("s1");
		expect(seen).toEqual([
			{ live: true, topics: ["alpha"] },
			{ live: false, topics: [] },
		]);
	});

	it("快照返回的是副本：改它不影响仓库内状态", () => {
		const reg = new ChannelSubscriptionRegistry(() => true);
		reg.report("s1", topics("alpha"));
		const snapshot = reg.snapshot("s1");
		snapshot.topics.push("injected");
		expect(reg.snapshot("s1").topics).toEqual(["alpha"]);
	});

	it("查询给的是读取时刻的进程时钟（renderer 按同代 revision 判新旧）", () => {
		const reg = new ChannelSubscriptionRegistry(() => true);
		reg.noteSessionOpened("s1");
		reg.report("s1", topics("alpha"));
		const first = reg.snapshot("s1");
		reg.noteSessionOpened("s2");
		reg.report("s2", topics("beta")); // 别的会话变化也会推进时钟
		const second = reg.snapshot("s1");
		expect(second.revision).toBeGreaterThan(first.revision);
		expect(second.topics).toEqual(first.topics);
	});
});

describe("ChannelSubscriptionRegistry · generation（每 open 一代）", () => {
	const make = () => new ChannelSubscriptionRegistry(() => true);

	it("关闭（dispose）后：无条件发布空集、保留代次值、标记 not-live", () => {
		const reg = make();
		const seen: Array<{ topics: string[]; generation: number; revision: number }> = [];
		reg.subscribe((s) => seen.push({ topics: s.topics, generation: s.generation, revision: s.revision }));
		reg.noteSessionOpened("s1");
		reg.report("s1", topics("alpha"));
		const beforeDispose = reg.snapshot("s1");
		reg.dispose("s1");
		const afterDispose = reg.snapshot("s1");

		expect(seen.at(-1)).toMatchObject({ topics: [], generation: beforeDispose.generation });
		expect(afterDispose.topics).toEqual([]);
		expect(afterDispose.generation).toBe(beforeDispose.generation); // 关闭状态下答案稳定
		expect(afterDispose.revision).toBeGreaterThan(beforeDispose.revision); // 旧响应因此仍被 revision 挡住
	});

	it("dispose 即使当前已无订阅也照样发布（生命周期信号，不依赖扩展 shutdown 上报）", () => {
		const reg = make();
		let publishes = 0;
		reg.subscribe(() => {
			publishes += 1;
		});
		reg.noteSessionOpened("s1");
		expect(publishes).toBe(0);
		reg.dispose("s1");
		expect(publishes).toBe(1);
	});

	it("关闭后重开 ⇒ 新的一代（代次严格增大）", () => {
		const reg = make();
		reg.noteSessionOpened("s1");
		reg.report("s1", topics("alpha"));
		const first = reg.snapshot("s1").generation;
		reg.dispose("s1");
		reg.noteSessionOpened("s1");
		reg.report("s1", topics("alpha"));
		expect(reg.snapshot("s1").generation).toBeGreaterThan(first);
	});

	it("早报不另占一代：注册确认时才定代次并用它发布一次（「每 open 恰好一代」字面成立）", () => {
		const reg = make();
		const events: Array<{ topics: string[]; generation: number }> = [];
		reg.subscribe((snapshot) => events.push({ topics: snapshot.topics, generation: snapshot.generation }));
		reg.report("s1", topics("alpha")); // 扩展构造期上报：还没有 registry.add
		expect(events).toEqual([]); // 还没定代次 ⇒ 不发布（避免 renderer 拿到一个会被顶掉的代次）
		expect(reg.snapshot("s1").topics).toEqual(["alpha"]); // 但查询已能查到（早报不丢）

		reg.noteSessionOpened("s1");
		const opened = reg.snapshot("s1");
		expect(events).toEqual([{ topics: ["alpha"], generation: opened.generation }]); // 用这一代发布一次
	});

	it("没有早报的会话：注册时不发布（renderer 的查询自己补齐）", () => {
		const reg = make();
		let publishes = 0;
		reg.subscribe(() => {
			publishes += 1;
		});
		reg.noteSessionOpened("s1");
		expect(publishes).toBe(0);
		reg.report("s1", topics("alpha"));
		expect(publishes).toBe(1); // 注册后的正常上报才发布
	});

	it("早报后没等到注册就 dispose：待发布状态一起清掉，不会用旧代次补发", () => {
		const reg = make();
		const events: Array<{ topics: string[]; generation: number }> = [];
		reg.subscribe((s) => events.push({ topics: s.topics, generation: s.generation }));
		reg.report("s1", topics("alpha"));
		reg.dispose("s1"); // 没注册就被处置
		expect(events).toEqual([{ topics: [], generation: 0 }]); // 只有 dispose 这一次（哨兵代次）
		reg.noteSessionOpened("s1"); // 之后的注册不会再补发早报
		expect(events).toHaveLength(1);
		expect(reg.snapshot("s1").topics).toEqual([]);
	});

	it("删除会话（磁盘也没了）：代次记录一起清 ⇒ 回到哨兵 0", () => {
		const reg = make();
		reg.noteSessionOpened("s1");
		reg.report("s1", topics("alpha"));
		reg.delete("s1");
		expect(reg.snapshot("s1")).toMatchObject({ topics: [], generation: 0 });
		expect(reg.loadedSessionIdsWithSubscriptions()).toEqual([]);
	});

	it("代次全局递增不重复（不同会话也不会撞）", () => {
		const reg = make();
		reg.noteSessionOpened("s1");
		reg.noteSessionOpened("s2");
		expect(reg.snapshot("s2").generation).toBeGreaterThan(reg.snapshot("s1").generation);
	});
});

describe("ChannelSubscriptionRegistry · GC 查询保持原语义", () => {
	it("只返回「仍在 registry 中」且有订阅的会话", () => {
		let loaded = true;
		const reg = new ChannelSubscriptionRegistry(() => loaded);
		reg.noteSessionOpened("s1");
		reg.report("s1", topics("alpha"));
		expect(reg.loadedSessionIdsWithSubscriptions()).toEqual(["s1"]);
		loaded = false; // 会话已不在 registry（异常/回调路径留下的孤儿键）
		expect(reg.loadedSessionIdsWithSubscriptions()).toEqual([]);
	});

	it("单会话快照**不**按 registry 过滤：早报的订阅在 registry.add 之前就能查到", () => {
		const reg = new ChannelSubscriptionRegistry(() => false); // 还没 add
		reg.report("s1", topics("alpha"));
		expect(reg.snapshot("s1").topics).toEqual(["alpha"]);
		expect(reg.loadedSessionIdsWithSubscriptions()).toEqual([]); // GC 查询仍是过滤后的
	});
});

describe("PiBackend 接线（stub session 注入私有 registry，同 session-close-guard 手法）", () => {
	function makeBackend(sessionId: string) {
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		registry.add({
			session: {
				sessionId,
				isStreaming: false,
				dispose: () => {},
				sessionFile: join(root, `${sessionId}.jsonl`),
				sessionManager: { getSessionDir: () => root, getSessionFile: () => join(root, `${sessionId}.jsonl`) },
			} as unknown as AgentSession,
			unsubscribe: () => {},
			cwd: root,
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
			modeRef: { get: () => "default" },
		} as never);
		return { backend, registry };
	}

	/** 模拟 `openSession` 里 registry.add 之后的那一步（stub harness 绕过了 wireSession） */
	const noteOpened = (backend: PiBackend, sessionId: string) =>
		(backend as unknown as { channelSubs: ChannelSubscriptionRegistry }).channelSubs.noteSessionOpened(
			sessionId,
		);

	it("上报 → 单会话查询拿到快照；事件同时可订阅", () => {
		const { backend } = makeBackend("s1");
		noteOpened(backend, "s1");
		const events: Array<{ sessionId: string; topics: string[] }> = [];
		const off = backend.onChannelSubscriptionsChanged((snapshot) =>
			events.push({ sessionId: snapshot.sessionId, topics: snapshot.topics }),
		);
		backend.reportChannelSubscriptions("s1", topics("alpha"));
		expect(events).toEqual([{ sessionId: "s1", topics: ["alpha"] }]);
		const snapshot = backend.getChannelSubscriptions("s1");
		expect(snapshot).toMatchObject({ sessionId: "s1", topics: ["alpha"] });
		expect(snapshot.generation).toBeGreaterThan(0);
		expect(snapshot.revision).toBeGreaterThan(0);
		off();
	});

	it("早报（还没注册确认）：查询查得到订阅但代次是哨兵、且不发事件", () => {
		const { backend } = makeBackend("s1");
		const events: string[] = [];
		const off = backend.onChannelSubscriptionsChanged((snapshot) => events.push(snapshot.sessionId));
		backend.reportChannelSubscriptions("s1", topics("alpha"));
		expect(events).toEqual([]); // 还没定代次 ⇒ 不发布
		expect(backend.getChannelSubscriptions("s1")).toMatchObject({
			topics: ["alpha"],
			generation: 0,
			live: false, // 还没有在册实例
		});
		noteOpened(backend, "s1"); // 注册确认：用这一代发一次
		expect(events).toEqual(["s1"]);
		const opened = backend.getChannelSubscriptions("s1");
		expect(opened.generation).toBeGreaterThan(0);
		expect(opened.live).toBe(true);
		off();
	});

	it("关闭会话（closeSession）后：查询得到空集且代次稳定（renderer 靠 revision 拒旧响应）", async () => {
		const { backend } = makeBackend("s1");
		noteOpened(backend, "s1");
		backend.reportChannelSubscriptions("s1", topics("alpha"));
		const before = backend.getChannelSubscriptions("s1");
		await backend.closeSession("s1");
		const after = backend.getChannelSubscriptions("s1");
		expect(after.topics).toEqual([]);
		expect(after.live).toBe(false); // 明确关闭信号（renderer 只认它，不认 topics 空）
		expect(after.generation).toBe(before.generation);
		expect(after.revision).toBeGreaterThan(before.revision);
	});

	it("GC 守卫语义不变：有订阅时 intent=gc 拒绝卸载；退订后放行", async () => {
		const { backend, registry } = makeBackend("s1");
		noteOpened(backend, "s1");
		backend.reportChannelSubscriptions("s1", topics("alpha"));
		await expect(backend.closeSession("s1", "gc")).resolves.toEqual({ closed: false });
		expect(registry.has("s1")).toBe(true);
		backend.reportChannelSubscriptions("s1", topics());
		await expect(backend.closeSession("s1", "gc")).resolves.toEqual({ closed: true });
		expect(registry.has("s1")).toBe(false);
	});

	it("GC 查询（getChannelSubscriptionSessionIds）保持原样：仍在 registry + 有订阅", () => {
		const { backend } = makeBackend("s1");
		noteOpened(backend, "s1");
		backend.reportChannelSubscriptions("s1", topics("alpha"));
		expect(backend.getChannelSubscriptionSessionIds()).toEqual(["s1"]);
		backend.reportChannelSubscriptions("孤儿会话", topics("beta"));
		expect(backend.getChannelSubscriptionSessionIds()).toEqual(["s1"]); // 不在 registry 的键被过滤
	});
});
