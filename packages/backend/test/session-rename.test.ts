import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionMeta } from "@percho/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { SessionRegistry } from "../src/session/registry";
import { renameSessionFile } from "../src/session/rename";

/** 会话改名两分支：活跃会话走 SDK（registry 命中）；历史会话离线写文件（registry 未命中） */

let testRoot = "";
/** 一个真实的会话文件（SessionManager.create 落在临时目录，不碰 ~/.pi/agent） */
let sessionFile = "";

beforeAll(async () => {
	testRoot = await mkdtemp(join(tmpdir(), "session-rename-"));
	const sm = SessionManager.create("/tmp/project", testRoot);
	sessionFile = sm.getSessionFile() ?? "";
	sm.appendMessage({ role: "user", content: "原始内容", timestamp: Date.now() } satisfies Message);
	// SDK 只在会话已有 assistant 消息时才把缓冲落盘（否则 flushed 恒 false→文件不生成）
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "回复" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude",
		timestamp: Date.now(),
	} as unknown as Message);
});

afterAll(async () => {
	await rm(testRoot, { recursive: true, force: true });
});

function makeBackend(session: Partial<AgentSession> = {}): PiBackend {
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({
		session: {
			sessionId: "active-1",
			setSessionName: () => {},
			sessionFile,
			...session,
		} as unknown as AgentSession,
		unsubscribe: () => {},
		cwd: "/tmp/project",
	});
	return backend;
}

function meta(partial: Partial<SessionMeta>): SessionMeta {
	return {
		sessionId: "hist-1",
		sessionFile,
		cwd: "/tmp/project",
		active: false,
		messageCount: 1,
		createdAt: 0,
		modifiedAt: 0,
		...partial,
	};
}

describe("renameSessionFile（历史会话离线改名）", () => {
	it("追加 session_info 后，重新打开文件能读到新名字（CLI/列表页同源可见）", async () => {
		renameSessionFile(sessionFile, "改过的名字");

		expect(SessionManager.open(sessionFile).getSessionName()).toBe("改过的名字");
		const raw = await readFile(sessionFile, "utf8");
		expect(raw).toContain("改过的名字");
	});

	it("文件不存在时抛错（不静默创建空会话文件）", () => {
		expect(() => renameSessionFile(join(testRoot, "nope.jsonl"), "x")).toThrow();
	});
});

describe("PiBackend.setSessionName 分支", () => {
	it("活跃会话走 SDK（autoName 事件由 SDK 发，不碰磁盘）", async () => {
		const setSessionName = vi.fn();
		const backend = makeBackend({ setSessionName } as unknown as Partial<AgentSession>);

		await backend.setSessionName("active-1", "活跃改名");

		expect(setSessionName).toHaveBeenCalledWith("活跃改名");
	});

	it("活跃的只读子会话（subagent 产物）拒绝改名", async () => {
		const backend = makeBackend();
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		const entry = registry.get("active-1");
		if (entry) entry.readOnly = true;

		await expect(backend.setSessionName("active-1", "x")).rejects.toThrow("read-only");
	});

	it("历史会话走离线文件写（registry 未命中）——无 cwd 时回退枚举", async () => {
		const backend = makeBackend();
		vi.spyOn(backend, "listAllSessions").mockResolvedValue([meta({})]);

		await backend.setSessionName("hist-1", "历史改名");

		expect(SessionManager.open(sessionFile).getSessionName()).toBe("历史改名");
	});

	// 1.0.4 新增 findById：只扫该项目的会话目录，不读全部会话 header（会话多时是数百毫秒的差别）
	it("历史会话带 cwd → 走 findById 精确查表，不做全量枚举", async () => {
		const backend = makeBackend();
		const findById = vi.spyOn(SessionManager, "findById").mockReturnValue(sessionFile);
		const listAll = vi.spyOn(backend, "listAllSessions").mockResolvedValue([]);

		await backend.setSessionName("hist-1", "精确查表改名", "/tmp/project");

		expect(findById).toHaveBeenCalledWith("/tmp/project", "hist-1");
		expect(listAll).not.toHaveBeenCalled();
		expect(SessionManager.open(sessionFile).getSessionName()).toBe("精确查表改名");
	});

	it("带 cwd 但 findById 查不到 → 回退枚举（投影与磁盘不一致时的兜底）", async () => {
		const backend = makeBackend();
		vi.spyOn(SessionManager, "findById").mockReturnValue(undefined);
		vi.spyOn(backend, "listAllSessions").mockResolvedValue([meta({})]);

		await backend.setSessionName("hist-1", "回退改名", "/tmp/other");

		expect(SessionManager.open(sessionFile).getSessionName()).toBe("回退改名");
	});

	it("历史会话不存在 → 抛 Session not found", async () => {
		const backend = makeBackend();
		vi.spyOn(backend, "listAllSessions").mockResolvedValue([]);

		await expect(backend.setSessionName("ghost", "x")).rejects.toThrow("Session not found");
	});

	it("历史的只读子会话（sessionFile 落在 sessions-subagents/）拒绝改名", async () => {
		const backend = makeBackend();
		// 只读判定靠 isSubagentSessionPath（前缀匹配 agent dir 下的 sessions-subagents）
		const subagentFile = join(getAgentDir(), "sessions-subagents", "sub.jsonl");
		vi.spyOn(backend, "listAllSessions").mockResolvedValue([meta({ sessionFile: subagentFile })]);

		await expect(backend.setSessionName("hist-1", "x")).rejects.toThrow("read-only");
	});

	// 新建未发消息的会话：sessionFile（路径）建会话时就有，SDK 把 session_info 写内存、
	// 首条消息落盘时一起写入 → 改名是合法操作，不得因 sessionFile 为空而拦（手测 1c/1d 实测）
	it("活跃会话 sessionFile 缺失（内存 manager）也走 SDK 改名，不做落盘前置拦", async () => {
		const setSessionName = vi.fn();
		const backend = makeBackend({
			sessionFile: undefined,
			setSessionName,
		} as unknown as Partial<AgentSession>);

		await backend.setSessionName("active-1", "x");

		expect(setSessionName).toHaveBeenCalledWith("x");
	});

	it("历史元信息缺文件路径（磁盘枚举不会出现）→ 报 Session not found", async () => {
		const backend = makeBackend();
		vi.spyOn(backend, "listAllSessions").mockResolvedValue([meta({ sessionFile: undefined })]);

		await expect(backend.setSessionName("hist-1", "x")).rejects.toThrow("Session not found");
	});
});
