import { describe, expect, it, vi } from "vitest";
import type { SessionGcEntry, SessionGcOpen } from "./session-gc";
import { runSessionGcRound, type SessionGcRoundDeps } from "./session-gc-run";

/** 空闲会话的 transcript 侧状态（全 false / 全空） */
const IDLE_ENTRY: SessionGcEntry = {
	agentActive: false,
	pendingPermissions: [],
	pendingDialogs: [],
	unseenCompletion: false,
	compacting: false,
	followUpQueue: [],
	messageCount: 0,
};

const NOW = 1_000_000_000;

function openSession(
	sessionId: string,
	lastUsedAt: number,
	extra: Partial<SessionGcOpen> = {},
): SessionGcOpen {
	return { sessionId, lastUsedAt, isDraft: false, messageCount: 4, ...extra };
}

function makeDeps(
	opts: {
		open?: SessionGcOpen[];
		activeSessionId?: string | null;
		subscribed?: string[];
		keep?: number;
		listError?: Error;
		/** 覆盖状态读取（用于「判定与执行之间状态变了」的场景） */
		getOpen?: () => { activeSessionId: string | null; open: SessionGcOpen[] };
		/** 后端是否同意卸（closed） */
		accepted?: (sessionId: string) => boolean;
	} = {},
) {
	const log = vi.fn();
	const unload = vi.fn(async (sessionId: string) => ({ closed: opts.accepted?.(sessionId) ?? true }));
	const deps: SessionGcRoundDeps = {
		getOpen:
			opts.getOpen ?? (() => ({ activeSessionId: opts.activeSessionId ?? null, open: opts.open ?? [] })),
		entryOf: () => IDLE_ENTRY,
		listSubscriptionSessionIds: opts.listError
			? () => Promise.reject(opts.listError)
			: () => Promise.resolve(opts.subscribed ?? []),
		unload,
		now: NOW,
		keep: opts.keep,
		log,
	};
	return { deps, unload, log };
}

describe("runSessionGcRound · 频道订阅快照消费", () => {
	it("快照里的会话进保护：最久未用也不卸、不占 K 名额（IPC 快照真被消费）", async () => {
		const open = [
			openSession("sub", NOW - 10_000_000),
			openSession("b", NOW - 60_000),
			openSession("c", NOW - 40_000),
			openSession("d", NOW - 20_000),
			openSession("e", NOW - 15_000),
		];
		const { deps, unload } = makeDeps({ open, subscribed: ["sub"] });

		const result = await runSessionGcRound(deps);

		expect(result.skipped).toBeNull();
		expect(result.unloaded).toEqual(["b"]); // 4 个可卸空闲抢 3 个名额 → 只卸最久未用的 b
		expect(unload).not.toHaveBeenCalledWith("sub");
	});

	it("不在快照里 → 行为与改动前一致（按纯策略正常回收）", async () => {
		const open = [openSession("a", NOW - 10_000_000), openSession("b", NOW - 60_000)];
		const { deps } = makeDeps({ open, keep: 1, subscribed: [] });

		const result = await runSessionGcRound(deps);

		expect(result.unloaded).toEqual(["a"]);
	});

	it("快照拉取失败 → 整轮跳过：一个都不卸、unload 零调用（未知保护范围 ≠ 无人订阅）", async () => {
		const open = [openSession("a", NOW - 10_000_000), openSession("b", NOW - 60_000)];
		const { deps, unload, log } = makeDeps({
			open,
			keep: 1,
			listError: new Error("IPC boom"),
		});

		const result = await runSessionGcRound(deps);

		expect(result).toEqual({ skipped: "subscription-snapshot-failed", unloaded: [], refused: [] });
		expect(unload).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith("[session-gc] 跳过本轮：频道订阅快照获取失败", expect.any(Error));
	});
});

describe("runSessionGcRound · 卸载前的再确认与后端拒绝", () => {
	it("判定与执行之间被切为活跃 → 不卸（用户的当前会话不能被抢）", async () => {
		const open = [openSession("old", NOW - 10_000_000)];
		let calls = 0;
		const { deps, unload } = makeDeps({
			keep: 1,
			getOpen: () => {
				calls += 1;
				// 第 1 次 = 算候选；第 2 次 = 卸载前再确认（此时用户切过来了）
				return { activeSessionId: calls === 1 ? null : "old", open };
			},
		});

		const result = await runSessionGcRound(deps);

		expect(unload).not.toHaveBeenCalled();
		expect(result.unloaded).toEqual([]);
	});

	it("判定与执行之间会话已被关掉（不在打开集合）→ 不卸、不发无效 IPC", async () => {
		const open = [openSession("old", NOW - 10_000_000)];
		let calls = 0;
		const { deps, unload } = makeDeps({
			keep: 1,
			getOpen: () => {
				calls += 1;
				return { activeSessionId: null, open: calls === 1 ? open : [] };
			},
		});

		const result = await runSessionGcRound(deps);

		expect(unload).not.toHaveBeenCalled();
		expect(result.unloaded).toEqual([]);
	});

	it("后端拒绝（closed=false）→ 记 refused，不算已卸（竞态：判定后又跑起来/刚订阅）", async () => {
		const open = [openSession("a", NOW - 10_000_000), openSession("b", NOW - 60_000)];
		const { deps } = makeDeps({
			open,
			keep: 1,
			accepted: (sessionId) => sessionId !== "a",
		});

		const result = await runSessionGcRound(deps);

		expect(result.refused).toEqual(["a"]);
		expect(result.unloaded).toEqual([]);
	});
});
