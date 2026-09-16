import type { LanSnapshot, LanSseFrame, LanTranscriptHistory, SessionTranscriptState } from "@percho/shared";
import { describe, expect, it } from "vitest";
import type { LanAppState } from "./store-pure";
import { applyFrame, initialLanState, seedSessions, seedTranscript } from "./store-pure";

const baseView = {
	sessionId: "s1",
	name: "测试会话",
	cwd: "/work",
	agentActive: false,
	compacting: false,
	queued: false,
	currentTool: null,
	assistantTail: null,
	todos: [],
	pendingPermission: null,
	lastError: null,
	stats: null,
	lastActivity: 1,
};

function snapshot(overrides: Partial<LanSnapshot> = {}): LanSnapshot {
	return {
		serverTime: 1,
		list: [{ sessionId: "s1", name: "测试会话", cwd: "/work", active: true, modifiedAt: 2 }],
		views: [baseView],
		transcripts: [
			{
				sessionId: "s1",
				state: {
					messages: [
						{ kind: "user", text: "你好", timestamp: 1 },
						{ kind: "assistant", text: "你好！**有什么**可以帮你？", timestamp: 2 },
					],
					agentActive: false,
					streaming: null,
				} as unknown as SessionTranscriptState,
				truncated: false,
			},
		],
		remoteControl: false,
		snapshotSeq: 10,
		...overrides,
	};
}

function eventFrame(sessionId: string, event: Record<string, unknown>, seq: number): LanSseFrame {
	return { event: "event", data: { sessionId, event, seq } } as LanSseFrame;
}

/** 流式进行中的快照：投影 state 含 in-flight 流式容器（服务端 reducer 驱动，D6 核心） */
function activeSnapshot(): LanSnapshot {
	return snapshot({
		views: [{ ...baseView, agentActive: true }],
		transcripts: [
			{
				sessionId: "s1",
				state: {
					messages: [],
					agentActive: true,
					streaming: { text: "你好", tools: [], activity: [], rawToolOutputs: {} },
				} as unknown as SessionTranscriptState,
				truncated: false,
			},
		],
	});
}

function deltaFrame(sessionId: string, delta: string, seq: number): LanSseFrame {
	return eventFrame(
		sessionId,
		{
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
		},
		seq,
	);
}

describe("lan-web store pure functions", () => {
	it("snapshot seeds transcripts via messagesToUIMessages", () => {
		const next = seedSessions(initialLanState, snapshot());
		expect(next.transcripts?.s1?.messages).toHaveLength(2);
		expect(next.transcripts?.s1?.messages[0]).toMatchObject({ kind: "user", text: "你好" });
		expect(next.transcripts?.s1?.messages[1]).toMatchObject({ kind: "assistant" });
		expect(next.snapshotSeq).toBe(10);
		expect(next.seeded).toBe(true);
	});

	it("event frames drive the shared reducer (agent_start + text_delta streaming)", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, snapshot()) };
		state = {
			...state,
			...applyFrame(state, eventFrame("s1", { type: "agent_start" }, 11)),
		};
		state = {
			...state,
			...applyFrame(
				state,
				eventFrame(
					"s1",
					{
						type: "message_update",
						message: { role: "assistant", content: [] },
						assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "正在" },
					},
					12,
				),
			),
		};
		expect(state.transcripts.s1?.streaming?.text).toBe("正在");
		expect(state.transcripts.s1?.agentActive).toBe(true);
	});

	it("drops event frames with seq <= snapshotSeq (already included in snapshot)", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, snapshot()) };
		state = {
			...state,
			...applyFrame(state, eventFrame("s1", { type: "agent_start" }, 5)),
		};
		expect(state.transcripts.s1?.streaming).toBeNull();
		expect(state.transcripts.s1?.agentActive).toBe(false);
	});

	it("perm frame lifecycle: perm adds, perm_resolved removes", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, snapshot()) };
		const request = {
			id: "r1",
			sessionId: "s1",
			title: "写文件",
			message: "edit a.ts",
			kind: "path" as const,
		};
		state = {
			...state,
			...applyFrame(state, { event: "perm", data: { sessionId: "s1", request, seq: 11 } }),
		};
		expect(state.pendingPerms.s1).toHaveLength(1);
		// 重复 perm 帧幂等
		state = {
			...state,
			...applyFrame(state, { event: "perm", data: { sessionId: "s1", request, seq: 12 } }),
		};
		expect(state.pendingPerms.s1).toHaveLength(1);
		state = {
			...state,
			...applyFrame(state, {
				event: "perm_resolved",
				data: { sessionId: "s1", requestId: "r1", answered: true, seq: 13 },
			}),
		};
		expect(state.pendingPerms.s1).toHaveLength(0);
	});

	it("view frame updates views only (transcript stays reducer-authoritative)", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, snapshot()) };
		state = {
			...state,
			...applyFrame(state, {
				event: "view",
				data: {
					sessionId: "s1",
					view: { ...baseView, agentActive: true, currentTool: "bash" },
					seq: 11,
				},
			}),
		};
		// D6：状态位从服务端投影派生（与服务端 reducer 同源），客户端 transcript 不回写——
		// 双写只会制造第二事实源（原 mid-run healing 层的根因）
		expect(state.views.s1?.agentActive).toBe(true);
		expect(state.views.s1?.currentTool).toBe("bash");
		expect(state.transcripts.s1?.agentActive).toBe(false);
	});

	it("mid-run join: snapshot carries streaming container, deltas append seamlessly", () => {
		// D6 核心场景：中途进入观察——服务端投影含 in-flight 流式容器，
		// 种子后到达的 delta 直接续接，无需 healing 兜底层
		let state = { ...initialLanState, ...seedSessions(initialLanState, activeSnapshot()) };
		expect(state.transcripts.s1?.streaming?.text).toBe("你好");
		state = { ...state, ...applyFrame(state, deltaFrame("s1", "，世界", 11)) };
		expect(state.transcripts.s1?.streaming?.text).toBe("你好，世界");
	});

	it("snapshot seeds pendingPermissions (M2 远程应答种子)", () => {
		const next = seedSessions(
			initialLanState,
			snapshot({
				pendingPermissions: [
					{ id: "r1", sessionId: "s1", title: "写文件", message: "edit a.ts", kind: "path" },
					{ id: "r2", sessionId: "s1", title: "执行命令", message: "ls", kind: "command" },
				],
				remoteControl: true,
			}),
		);
		expect(next.pendingPerms?.s1?.map((r) => r.id)).toEqual(["r1", "r2"]);
		expect(next.remoteControl).toBe(true);
	});

	it("reconnect re-seed heals state (snapshot authoritative)", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, snapshot()) };
		state = {
			...state,
			...applyFrame(state, eventFrame("s1", { type: "agent_start" }, 11)),
		};
		expect(state.transcripts.s1?.streaming).not.toBeNull();
		// 重连重拉：streaming 清空回到快照状态
		state = { ...state, ...seedSessions(state, snapshot()) };
		expect(state.transcripts.s1?.streaming).toBeNull();
		expect(state.transcripts.s1?.messages).toHaveLength(2);
	});

	it("selected survives re-seed when session still exists, resets otherwise", () => {
		const seeded = {
			...initialLanState,
			...seedSessions({ ...initialLanState, selected: "s1" }, snapshot()),
		};
		expect(seeded.selected).toBe("s1");
		const gone = seedSessions(seeded as never, {
			...snapshot(),
			list: [],
			views: [],
			transcripts: [],
		});
		expect(gone.selected).toBeNull();
	});

	it("seedTranscript seeds history session on demand, never overwrites existing", () => {
		const entry: LanTranscriptHistory = {
			sessionId: "hist-1",
			messages: [{ role: "user", text: "旧消息", thinking: "", tools: [], images: [], timestamp: 1 }],
			truncated: true,
		};
		const seeded = seedTranscript(initialLanState, entry);
		expect(seeded.transcripts?.["hist-1"]?.messages).toHaveLength(1);
		expect(seeded.truncated?.["hist-1"]).toBe(true);
		// 已有种子不覆盖（流式进行中保护）
		const again = seedTranscript({ ...initialLanState, transcripts: seeded.transcripts } as LanAppState, {
			...entry,
			messages: [],
		});
		expect(again.transcripts).toBeUndefined();
	});
});
