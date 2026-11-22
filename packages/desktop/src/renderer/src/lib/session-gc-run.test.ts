import { emptyTranscript, environmentEntityKey, LOCAL_ENVIRONMENT, reduceEvent } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionGcEntry, SessionGcOpen } from "./session-gc";
import { runEnvironmentSessionGc, runSessionGcRound, type SessionGcRoundDeps } from "./session-gc-run";

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
	return { sessionId, lastUsedAt, messageCount: 4, ...extra };
}

function makeDeps(
	opts: {
		open?: SessionGcOpen[];
		activeSessionId?: string | null;
		keep?: number;
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
		unload,
		now: NOW,
		keep: opts.keep,
		log,
	};
	return { deps, unload, log };
}

describe("runSessionGcRound · 普通回收", () => {
	it("不查询频道订阅，空闲会话按普通策略卸载", async () => {
		const open = [
			openSession("sub", NOW - 10_000_000),
			openSession("b", NOW - 60_000),
			openSession("c", NOW - 40_000),
			openSession("d", NOW - 20_000),
			openSession("e", NOW - 15_000),
		];
		const { deps, unload } = makeDeps({ open });

		const result = await runSessionGcRound(deps);

		expect(result.skipped).toBeNull();
		expect(result.unloaded).toEqual(["sub", "b"]);
		expect(unload).toHaveBeenCalledWith("sub");
	});

	it("按纯策略正常回收", async () => {
		const open = [openSession("a", NOW - 10_000_000), openSession("b", NOW - 60_000)];
		const { deps } = makeDeps({ open, keep: 1 });

		const result = await runSessionGcRound(deps);

		expect(result.unloaded).toEqual(["a"]);
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

	it("后端拒绝（closed=false）→ 记 refused，不算已卸（竞态：判定后又跑起来）", async () => {
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

it("uses independent local and remote retention budgets without subscription queries", async () => {
	const remote = { kind: "ssh" as const, connectionId: "company", environmentId: "data" };
	const key = (id: string) => environmentEntityKey(remote, id);
	const { deps, unload } = makeDeps({
		open: [
			openSession("a", NOW - 10_000_000),
			openSession("b", NOW - 60_000),
			openSession(key("a"), NOW - 10_000_000),
			openSession(key("b"), NOW - 60_000),
		],
		keep: 1,
	});
	const results = await runEnvironmentSessionGc([LOCAL_ENVIRONMENT, remote], {
		...deps,
	});
	expect(results[0]?.unloaded).toEqual(["a"]);
	expect(results[1]?.unloaded).toEqual([key("a")]);
	expect(unload).toHaveBeenCalledTimes(2);
});

it("retains paused queues independently in local and remote environments", async () => {
	const remote = { kind: "ssh" as const, connectionId: "fixture", environmentId: "isolated" };
	const remoteId = environmentEntityKey(remote, "paused");
	const { deps, unload } = makeDeps({
		open: ["paused", remoteId, "idle"].map((id) => openSession(id, NOW - 10_000_000)),
		keep: 0,
	});
	let paused = reduceEvent(emptyTranscript(), { type: "queue_update", steering: [], followUp: ["pending"] });
	paused = reduceEvent(paused, { type: "compaction_pause", pause: { reason: "failed" } });
	const results = await runEnvironmentSessionGc([LOCAL_ENVIRONMENT, remote], {
		...deps,
		entryOf: (id) =>
			id === "idle"
				? IDLE_ENTRY
				: { ...paused, messageCount: paused.messages.length, pendingPermissions: [], pendingDialogs: [] },
	});
	expect(results.flatMap((result) => result.unloaded)).toEqual(["idle"]);
	expect(unload).toHaveBeenCalledExactlyOnceWith("idle");
});
