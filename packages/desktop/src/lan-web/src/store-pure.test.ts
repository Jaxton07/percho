import type { LanSnapshot, LanSseFrame, LanTranscript, SessionMessage } from "@percho/shared";
import { describe, expect, it } from "vitest";
import type { LanAppState } from "./store-pure";
import { applyFrame, healingTailSuffix, initialLanState, seedSessions, seedTranscript } from "./store-pure";

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
				messages: [
					{ role: "user", text: "你好", thinking: "", tools: [], images: [], timestamp: 1 },
					{
						role: "assistant",
						text: "你好！**有什么**可以帮你？",
						thinking: "",
						tools: [],
						images: [],
						timestamp: 2,
					},
				] as SessionMessage[],
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

/** 流式进行中的视图（healing 标记的 agentActive 守卫需要） */
function activeSnapshot(): LanSnapshot {
	return snapshot({ views: [{ ...baseView, agentActive: true }] });
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

	it("mid-run join: orphan delta flags streamHealing; container rebuild clears it", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, activeSnapshot()) };
		// 中途进入：错过 message_start，text_delta 在 reducer 空转 → 标记兑底（值 = 触发帧的新增字节数）
		state = { ...state, ...applyFrame(state, deltaFrame("s1", "你好", 11)) };
		expect(state.streamHealing.s1).toBe(2);
		expect(state.transcripts.s1?.streaming).toBeNull();
		// 后续空转 delta 继续累加新鲜字节数（气泡差量渲染的数据源）
		state = { ...state, ...applyFrame(state, deltaFrame("s1", "世界！", 12)) };
		expect(state.streamHealing.s1).toBe(5);
		// 容器重建（agent_start）→ 摘标记，后续 delta 正常累积不再误标
		state = { ...state, ...applyFrame(state, eventFrame("s1", { type: "agent_start" }, 13)) };
		expect(state.streamHealing.s1).toBeUndefined();
		state = { ...state, ...applyFrame(state, deltaFrame("s1", "在", 14)) };
		expect(state.streamHealing.s1).toBeUndefined();
		expect(state.transcripts.s1?.streaming?.text).toBe("在");
	});

	it("mid-run join: orphan turn_end boundary clears flag (refetch wired in store.ts)", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, activeSnapshot()) };
		state = { ...state, ...applyFrame(state, deltaFrame("s1", "x", 11)) };
		expect(state.streamHealing.s1).toBe(1);
		state = { ...state, ...applyFrame(state, eventFrame("s1", { type: "turn_end" }, 12)) };
		expect(state.streamHealing.s1).toBeUndefined();
	});

	it("orphan delta on idle session does not flag streamHealing (agentActive guard)", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, snapshot()) };
		state = { ...state, ...applyFrame(state, deltaFrame("s1", "x", 11)) };
		expect(state.streamHealing.s1).toBeUndefined();
	});

	it("re-seed clears streamHealing (fresh authoritative state)", () => {
		let state = { ...initialLanState, ...seedSessions(initialLanState, activeSnapshot()) };
		state = { ...state, ...applyFrame(state, deltaFrame("s1", "x", 11)) };
		expect(state.streamHealing.s1).toBe(1);
		state = { ...state, ...seedSessions(state, activeSnapshot()) };
		expect(state.streamHealing).toEqual({});
	});

	describe("healingTailSuffix", () => {
		it("renders only the fresh suffix of the projected tail", () => {
			// 种子 partial “Hel”，投影 tail 已长到 “Hello wor” → 只渲染新增的 “lo wor”
			expect(healingTailSuffix("Hello wor", 5)).toBe("o wor");
		});

		it("fresh bytes beyond tail length renders whole tail (window slid past seed)", () => {
			expect(healingTailSuffix("abc", 99)).toBe("abc");
		});

		it("no fresh bytes or empty tail renders nothing (no duplicated body)", () => {
			expect(healingTailSuffix("Hello wor", 0)).toBe("");
			expect(healingTailSuffix(null, 5)).toBe("");
			expect(healingTailSuffix(undefined, 5)).toBe("");
		});
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

	it("view frame updates status bits on existing transcript", () => {
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
		expect(state.transcripts.s1?.agentActive).toBe(true);
		expect(state.views.s1?.currentTool).toBe("bash");
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
		const entry: LanTranscript = {
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
