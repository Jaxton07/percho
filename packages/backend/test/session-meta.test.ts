import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RegisteredSession, SessionRegistry } from "../src/session/registry";

/**
 * 阶段 0 红测（spec sidebar-session-switch-stability D1 / §5 排序 3-4）：
 * 活跃会话 meta 的时间字段必须与磁盘枚举同语义 —— createdAt = session header 时间（**不是**文件 birthtime，
 * 复制/恢复文件会改 birthtime），modifiedAt = 所有 user/assistant 消息的最大活动时间
 * （message.timestamp 数值优先，退回 entry timestamp；custom/tool 类 entry 不影响）。
 *
 * 现状（红）：toMeta 用 statSync(file).birthtimeMs 当 createdAt，且完全没有 modifiedAt →
 * 左栏排序键从 modifiedAt 掉到 createdAt，点击行下移。实现见 plan 阶段 1.1。
 */

const PROJECT = "/tmp/project";
const CREATED_ISO = "2020-01-01T00:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_ISO);
const USER_TS = Date.parse("2021-03-04T05:06:07.000Z");
const ASSISTANT_TS = Date.parse("2022-07-08T09:10:11.000Z");
/** 比所有消息都晚的 custom entry（channel cursor 同类）：绝不能当成会话活动时间 */
const CUSTOM_ISO = "2023-05-06T07:08:09.000Z";

interface MessageSpec {
	id: string;
	role: string;
	/** message 自带的数值时间戳（缺省则退回 entry timestamp） */
	timestamp?: number;
	/** entry 的 ISO 时间戳 */
	entryTimestamp: string;
}

function messageEntry(spec: MessageSpec): unknown {
	return {
		type: "message",
		id: spec.id,
		parentId: null,
		timestamp: spec.entryTimestamp,
		message: {
			role: spec.role,
			content: "x",
			...(spec.timestamp === undefined ? {} : { timestamp: spec.timestamp }),
		},
	};
}

function customEntry(id: string, entryTimestamp: string): unknown {
	return { type: "custom", id, parentId: null, timestamp: entryTimestamp, customType: "channel-cursor" };
}

/** 按真实 pi 会话文件格式手写一份会话（header + 逐行 entry），零 SDK 写入 */
function writeSessionFile(dir: string, id: string, entries: unknown[]): string {
	const file = join(dir, `${id}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: CREATED_ISO, cwd: PROJECT }),
		...entries.map((entry) => JSON.stringify(entry)),
	];
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

/** 最小 RegisteredSession 桩：sessionManager 是真的（读 header/entries），不构造 AgentSession */
function entryFor(file: string, sessionId: string): RegisteredSession {
	return {
		session: {
			sessionId,
			sessionFile: file,
			sessionName: undefined,
			model: null,
			thinkingLevel: "medium",
			messages: [],
			sessionManager: SessionManager.open(file),
		} as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: PROJECT,
		gate: { dispose: () => {} },
		dialogs: { dispose: () => {} },
		modeRef: { current: "default" },
	} as unknown as RegisteredSession;
}

function metaOf(file: string, sessionId: string) {
	return new SessionRegistry().toMeta(entryFor(file, sessionId));
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-meta-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("SessionRegistry.toMeta · 时间语义（spec D1）", () => {
	it("createdAt 取 header 时间（不是文件 birthtime）；modifiedAt 取 user/assistant 最大活动时间", () => {
		const file = writeSessionFile(dir, "sess-a", [
			messageEntry({
				id: "m1",
				role: "user",
				timestamp: USER_TS,
				entryTimestamp: "2021-03-04T05:06:07.000Z",
			}),
			customEntry("c1", CUSTOM_ISO),
			messageEntry({
				id: "m2",
				role: "assistant",
				timestamp: ASSISTANT_TS,
				entryTimestamp: "2022-07-08T09:10:11.000Z",
			}),
		]);

		const meta = metaOf(file, "sess-a");

		expect(meta.createdAt).toBe(CREATED_MS);
		expect(meta.modifiedAt).toBe(ASSISTANT_TS);
		// 反证：文件刚写出来，birthtime 是「现在」，与 header 时间（2020）必然不同
		expect(statSync(file).birthtimeMs).not.toBe(CREATED_MS);
	});

	it("custom / toolResult 类 entry 不影响 modifiedAt（channel cursor 不参与排序）", () => {
		const file = writeSessionFile(dir, "sess-b", [
			messageEntry({
				id: "m1",
				role: "user",
				timestamp: USER_TS,
				entryTimestamp: "2021-03-04T05:06:07.000Z",
			}),
			messageEntry({
				id: "m2",
				role: "toolResult",
				timestamp: ASSISTANT_TS,
				entryTimestamp: "2022-07-08T09:10:11.000Z",
			}),
			customEntry("c1", CUSTOM_ISO),
		]);

		expect(metaOf(file, "sess-b").modifiedAt).toBe(USER_TS);
	});

	it("消息没有数值 timestamp 时退回 entry timestamp", () => {
		const file = writeSessionFile(dir, "sess-c", [
			messageEntry({ id: "m1", role: "user", entryTimestamp: "2021-03-04T05:06:07.000Z" }),
		]);

		expect(metaOf(file, "sess-c").modifiedAt).toBe(USER_TS);
	});

	it("没有任何 user/assistant 消息：modifiedAt = createdAt", () => {
		const file = writeSessionFile(dir, "sess-d", [customEntry("c1", CUSTOM_ISO)]);

		const meta = metaOf(file, "sess-d");

		expect(meta.createdAt).toBe(CREATED_MS);
		expect(meta.modifiedAt).toBe(CREATED_MS);
	});

	it("与 SDK 磁盘枚举同语义：SessionManager.list 的 created/modified 与活跃 meta 一致", async () => {
		const file = writeSessionFile(dir, "sess-e", [
			messageEntry({
				id: "m1",
				role: "user",
				timestamp: USER_TS,
				entryTimestamp: "2021-03-04T05:06:07.000Z",
			}),
			customEntry("c1", CUSTOM_ISO),
			messageEntry({
				id: "m2",
				role: "assistant",
				timestamp: ASSISTANT_TS,
				entryTimestamp: "2022-07-08T09:10:11.000Z",
			}),
		]);
		const infos = await SessionManager.list(PROJECT, dir);
		const info = infos.find((item) => item.id === "sess-e");
		if (!info) throw new Error("session file not enumerated");

		const meta = metaOf(file, "sess-e");

		expect(meta.createdAt).toBe(info.created.getTime());
		expect(meta.modifiedAt).toBe(info.modified.getTime());
	});

	it("复制会话文件（birthtime 变新）不改变 createdAt", () => {
		const file = writeSessionFile(dir, "sess-f", [
			messageEntry({
				id: "m1",
				role: "user",
				timestamp: USER_TS,
				entryTimestamp: "2021-03-04T05:06:07.000Z",
			}),
		]);
		const copyDir = mkdtempSync(join(tmpdir(), "session-meta-copy-"));
		const copy = join(copyDir, "sess-f-copy.jsonl");
		copyFileSync(file, copy);

		try {
			const meta = metaOf(copy, "sess-f");
			expect(meta.createdAt).toBe(CREATED_MS);
			expect(meta.modifiedAt).toBe(USER_TS);
			// 副本的 birthtime 是复制时刻（远比 2020 晚）：证明没在用 birthtime
			expect(statSync(copy).birthtimeMs).toBeGreaterThan(CREATED_MS + 86_400_000);
		} finally {
			rmSync(copyDir, { recursive: true, force: true });
		}
	});
});
