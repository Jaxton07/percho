import type { SessionMeta } from "@percho/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** window.pi 的 mock：工作区 store 经 getPi() 访问，测试环境无 preload 注入 */
type SaveUiStatePayload = { state: { sessionWorkspace: { files: string[]; activeFile: string | null } } };
const piMock = vi.hoisted(() => ({
	saveUiState: vi.fn((_payload: unknown) => Promise.resolve()),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import {
	insertMember,
	isWorkspaceRecording,
	memberIndexOf,
	moveMember,
	nextActiveFile,
	normalizeMembers,
	pruneMembers,
	resolveMembersByFile,
	resolveWorkspaceSessions,
	useSessionWorkspaceStore,
	type WorkspaceMember,
	workspaceFileKey,
	workspaceSnapshotOf,
} from "./session-workspace";
import { useUiPreferencesStore } from "./ui-preferences";

const member = (id: string, file = `/${id}.jsonl`): WorkspaceMember => ({ file, sessionId: id });
const filesOf = (members: readonly WorkspaceMember[]) => members.map((m) => m.file);

function resetStores(): void {
	useSessionWorkspaceStore.setState({ members: [], activeFile: null, epoch: 0 });
	// 两个开关一次写回，避免触发「双关清空」的订阅分支
	useUiPreferencesStore.setState({ barSessionsVisible: true, sessionRailEnabled: false });
}

beforeEach(async () => {
	// 先让上一条用例遗留的合并式持久化 flush 跑完，否则它会污染本用例的 saveUiState 调用数
	for (let i = 0; i < 5; i++) await Promise.resolve();
	vi.clearAllMocks();
	resetStores();
});

describe("纯函数", () => {
	it("workspaceFileKey：trim 规范化，空/非字符串 → null", () => {
		expect(workspaceFileKey(" /a.jsonl ")).toBe("/a.jsonl");
		expect(workspaceFileKey("")).toBeNull();
		expect(workspaceFileKey("   ")).toBeNull();
		expect(workspaceFileKey(undefined)).toBeNull();
		expect(workspaceFileKey(null)).toBeNull();
	});

	it("memberIndexOf：file 优先、sessionId 兜底（两把键都认）", () => {
		const members = [member("a"), member("b")];
		expect(memberIndexOf(members, "/b.jsonl")).toBe(1);
		expect(memberIndexOf(members, "b")).toBe(1);
		expect(memberIndexOf(members, "/gone.jsonl")).toBe(-1);
		expect(memberIndexOf(members, null)).toBe(-1);
	});

	it("insertMember：插在锚点右侧；锚点不在工作区 → 追加末尾；已存在 → 同引用", () => {
		const members = [member("a"), member("b")];
		expect(filesOf(insertMember(members, member("c"), "/a.jsonl"))).toEqual([
			"/a.jsonl",
			"/c.jsonl",
			"/b.jsonl",
		]);
		expect(filesOf(insertMember(members, member("c"), null))).toEqual(["/a.jsonl", "/b.jsonl", "/c.jsonl"]);
		expect(filesOf(insertMember(members, member("c"), "/gone.jsonl"))).toEqual([
			"/a.jsonl",
			"/b.jsonl",
			"/c.jsonl",
		]);
		expect(insertMember(members, member("a"), "/b.jsonl")).toBe(members);
		// 同 sessionId 不同 file 也算同一成员（别名路径不新增记录）
		expect(insertMember(members, { file: "/alias.jsonl", sessionId: "a" }, null)).toBe(members);
	});

	it("nextActiveFile：右邻优先、否则左邻、都没有 → null", () => {
		const members = [member("a"), member("b"), member("c")];
		expect(nextActiveFile(members, "/b.jsonl")).toBe("/c.jsonl");
		expect(nextActiveFile(members, "/c.jsonl")).toBe("/b.jsonl");
		expect(nextActiveFile([member("a")], "/a.jsonl")).toBeNull();
		expect(nextActiveFile(members, "/gone.jsonl")).toBeNull();
	});

	it("moveMember：把 from 挪到 to 的位置；未知键/同位 → 同引用", () => {
		const members = [member("a"), member("b"), member("c")];
		expect(filesOf(moveMember(members, "c", "a"))).toEqual(["/c.jsonl", "/a.jsonl", "/b.jsonl"]);
		expect(moveMember(members, "a", "a")).toBe(members);
		expect(moveMember(members, "ghost", "a")).toBe(members);
	});

	it("pruneMembers：失效项剔除；没有变化时返回同引用", () => {
		const members = [member("a"), member("b"), member("c")];
		expect(filesOf(pruneMembers(members, (m) => m.sessionId !== "b"))).toEqual(["/a.jsonl", "/c.jsonl"]);
		expect(pruneMembers(members, () => true)).toBe(members);
	});

	it("normalizeMembers：丢掉无 file/无 id 的脏条目，按 file 与 sessionId 双键去重保序", () => {
		expect(
			normalizeMembers([
				member("a"),
				{ file: " /a.jsonl ", sessionId: "a-alias" },
				{ file: "", sessionId: "x" },
				{ file: "/b.jsonl", sessionId: "" },
				null,
				member("b"),
			]),
		).toEqual([member("a"), member("b")]);
		expect(normalizeMembers("x")).toEqual([]);
	});

	it("normalizeMembers：重复 sessionId 不同 file → 只保留首次出现（同一会话不出两条记录）", () => {
		expect(
			normalizeMembers([
				{ file: "/a.jsonl", sessionId: "s" },
				{ file: "/b.jsonl", sessionId: "s" },
				{ file: "/c.jsonl", sessionId: "t" },
			]),
		).toEqual([member("s", "/a.jsonl"), member("t", "/c.jsonl")]);
		// 别名路径在前时同样只留一条（先到者胜，与 addMember 同口径）
		expect(
			normalizeMembers([
				{ file: "/alias.jsonl", sessionId: "s" },
				{ file: "/a.jsonl", sessionId: "s" },
			]),
		).toEqual([member("s", "/alias.jsonl")]);
	});

	it("workspaceSnapshotOf：activeFile 不在成员里 → null", () => {
		expect(workspaceSnapshotOf([member("a")], "/a.jsonl")).toEqual({
			files: ["/a.jsonl"],
			activeFile: "/a.jsonl",
		});
		expect(workspaceSnapshotOf([member("a")], "/gone.jsonl")).toEqual({
			files: ["/a.jsonl"],
			activeFile: null,
		});
	});

	describe("resolveMembersByFile（启动恢复：快照 → 内存成员）", () => {
		const meta = (id: string, file: string | undefined, extra: Partial<SessionMeta> = {}): SessionMeta => ({
			sessionId: id,
			sessionFile: file,
			cwd: "/p",
			active: false,
			messageCount: 1,
			createdAt: 1,
			...extra,
		});

		it("按文件路径解析、保持快照顺序（名字/存在性只认目录投影）", () => {
			const history = [meta("a", "/a.jsonl"), meta("b", "/b.jsonl", { name: "目录名" })];
			expect(resolveMembersByFile(["/b.jsonl", "/a.jsonl"], history)).toEqual([
				{ file: "/b.jsonl", sessionId: "b" },
				{ file: "/a.jsonl", sessionId: "a" },
			]);
		});

		it("失效项不生成成员：已删、只读子代理、0 消息会话（只有计划路径，目录里没有）", () => {
			const history = [meta("a", "/a.jsonl"), meta("sub", "/sub.jsonl", { readOnly: true })];
			expect(resolveMembersByFile(["/gone.jsonl", "/a.jsonl", "/sub.jsonl", "/c.jsonl"], history)).toEqual([
				{ file: "/a.jsonl", sessionId: "a" },
			]);
		});

		it("重复 id（脏别名）只留首条；无 sessionFile 的目录项不匹配任何路径", () => {
			expect(
				resolveMembersByFile(
					["/a.jsonl", "/alias.jsonl"],
					[meta("a", "/a.jsonl"), meta("a", "/alias.jsonl")],
				),
			).toEqual([{ file: "/a.jsonl", sessionId: "a" }]);
			expect(resolveMembersByFile(["/a.jsonl"], [meta("a", undefined)])).toEqual([]);
		});
	});

	describe("resolveWorkspaceSessions（读侧展示集）", () => {
		const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
			sessionId: id,
			sessionFile: `/${id}.jsonl`,
			cwd: "/p",
			active: true,
			messageCount: 1,
			createdAt: 1,
			...extra,
		});

		it("顺序 = 成员顺序；tabs 优先、历史兜底（被卸载的成员照样出胶囊）", () => {
			const tabs = [meta("b", { name: "b-tab" })];
			const history = [meta("a"), meta("b", { name: "b-history" }), meta("c")];
			const out = resolveWorkspaceSessions([member("c"), member("a"), member("b")], tabs, history);
			expect(out.map((s) => s.sessionId)).toEqual(["c", "a", "b"]);
			expect(out[2]?.name).toBe("b-tab");
		});

		it("历史里也没有的成员跳过（会话已删）；只读子代理不进工作区", () => {
			const history = [meta("a"), meta("sub", { readOnly: true })];
			expect(
				resolveWorkspaceSessions([member("a"), member("ghost"), member("sub")], [], history).map(
					(s) => s.sessionId,
				),
			).toEqual(["a"]);
		});

		it("纵深防御：同一 sessionId 出现两次（旁路数据）也只出一个胶囊", () => {
			const history = [meta("a"), meta("b")];
			const out = resolveWorkspaceSessions(
				[member("a"), { file: "/a-alias.jsonl", sessionId: "a" }, member("b")],
				[],
				history,
			);
			expect(out.map((s) => s.sessionId)).toEqual(["a", "b"]);
		});
	});
});

describe("useSessionWorkspaceStore（记录与持久化）", () => {
	it("默认空（旧 ui-state 无快照）", async () => {
		const state = useSessionWorkspaceStore.getState();
		expect(state.members).toEqual([]);
		expect(state.activeFile).toBeNull();
		expect(state.epoch).toBe(0);
		// 空态下的任何读侧动作都不写盘
		await Promise.resolve();
		expect(piMock.saveUiState).not.toHaveBeenCalled();
	});

	it("添加：新成员插在当前成员右侧，active 跟随新成员并落盘", async () => {
		const store = useSessionWorkspaceStore.getState();
		expect(store.addMember({ file: "/a.jsonl", sessionId: "a" })).toBe(true);
		expect(useSessionWorkspaceStore.getState().members).toEqual([member("a")]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/a.jsonl");

		useSessionWorkspaceStore.getState().addMember({ file: "/b.jsonl", sessionId: "b" });
		// 锚点 = 当前成员 a → b 插在 a 右侧
		useSessionWorkspaceStore
			.getState()
			.addMember({ file: "/c.jsonl", sessionId: "c" }, { anchorFile: "/a.jsonl" });
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual([
			"/a.jsonl",
			"/c.jsonl",
			"/b.jsonl",
		]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/c.jsonl");

		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: {
					sessionWorkspace: {
						files: ["/a.jsonl", "/c.jsonl", "/b.jsonl"],
						activeFile: "/c.jsonl",
					},
				},
			}),
		);
	});

	it("没有任何「最近看过」的锚点时（恢复出的工作区没有 activeFile）→ 追加末尾", () => {
		// replaceAll 传 null activeFile = 上次停在只读检视/没打开过成员 → recentFile 也是 null
		useSessionWorkspaceStore.getState().replaceAll([member("a"), member("b")], null);
		useSessionWorkspaceStore.getState().addMember({ file: "/c.jsonl", sessionId: "c" });
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual([
			"/a.jsonl",
			"/b.jsonl",
			"/c.jsonl",
		]);
	});

	it("anchorFile()：当前成员优先、否则回落最近看过的成员（导航前取锚点的唯一入口）", () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b"]) store.addMember(member(id));
		expect(useSessionWorkspaceStore.getState().anchorFile()).toBe("/b.jsonl");
		useSessionWorkspaceStore.getState().setActive("/a.jsonl");
		expect(useSessionWorkspaceStore.getState().anchorFile()).toBe("/a.jsonl");
		// 进新会话页：当前成员为 null，但「刚看过 a」仍然是锚点
		useSessionWorkspaceStore.getState().setActive(null);
		expect(useSessionWorkspaceStore.getState().anchorFile()).toBe("/a.jsonl");
	});

	it("新会话页上转正（promotion）：插在「刚看过的那个成员」右侧，不是末尾", () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b", "c"]) store.addMember(member(id));
		// 看着 b → 点「＋」进新会话页：activeFile 按 spec 置 null（重启回新会话页），但 recentFile 记住 b
		useSessionWorkspaceStore.getState().setActive("/b.jsonl");
		useSessionWorkspaceStore.getState().setActive(null);
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();

		useSessionWorkspaceStore.getState().addMember({ file: "/new.jsonl", sessionId: "new" });
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual([
			"/a.jsonl",
			"/b.jsonl",
			"/new.jsonl",
			"/c.jsonl",
		]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/new.jsonl");
	});

	it("最近看过的成员被移出后，锚点不挂在已不存在的成员上（回落末尾）", () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b"]) store.addMember(member(id));
		useSessionWorkspaceStore.getState().setActive("/b.jsonl");
		useSessionWorkspaceStore.getState().setActive(null);
		useSessionWorkspaceStore.getState().removeMember("/b.jsonl");

		useSessionWorkspaceStore.getState().addMember({ file: "/new.jsonl", sessionId: "new" });
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/a.jsonl", "/new.jsonl"]);
	});

	it("清空工作区后锚点也清掉：新成员从空表重新起头", () => {
		const store = useSessionWorkspaceStore.getState();
		store.addMember(member("a"));
		useSessionWorkspaceStore.getState().setActive(null);
		useSessionWorkspaceStore.getState().clear();

		useSessionWorkspaceStore.getState().addMember(member("b"));
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/b.jsonl"]);
	});

	it("重复打开已加入的会话：只激活、不挪位（顺序不跳动）", async () => {
		const store = useSessionWorkspaceStore.getState();
		store.addMember({ file: "/a.jsonl", sessionId: "a" });
		store.addMember({ file: "/b.jsonl", sessionId: "b" });
		useSessionWorkspaceStore.getState().setActive("/a.jsonl");
		vi.clearAllMocks();

		expect(useSessionWorkspaceStore.getState().addMember({ file: "/b.jsonl", sessionId: "b" })).toBe(true);
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/a.jsonl", "/b.jsonl"]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/b.jsonl");
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: ["/a.jsonl", "/b.jsonl"], activeFile: "/b.jsonl" } },
			}),
		);

		// 同 sessionId 换了文件路径：仍是一条记录（只激活）
		vi.clearAllMocks();
		useSessionWorkspaceStore.getState().addMember({ file: "/alias.jsonl", sessionId: "b" });
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/a.jsonl", "/b.jsonl"]);
		expect(piMock.saveUiState).not.toHaveBeenCalled();
	});

	it("脏输入不记录：缺文件路径或会话 id（防御内存会话/未落盘会话）", () => {
		const store = useSessionWorkspaceStore.getState();
		expect(store.addMember({ file: "", sessionId: "a" })).toBe(false);
		expect(store.addMember({ file: "   ", sessionId: "a" })).toBe(false);
		expect(store.addMember({ file: "/a.jsonl", sessionId: null })).toBe(false);
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
		expect(piMock.saveUiState).not.toHaveBeenCalled();
	});

	it("addMember(activate:false)：迟到结果只入表，不抢 activeFile", () => {
		const store = useSessionWorkspaceStore.getState();
		store.addMember(member("a"));
		store.addMember(member("b"));
		useSessionWorkspaceStore.getState().setActive("/a.jsonl");

		useSessionWorkspaceStore
			.getState()
			.addMember(member("late"), { anchorFile: "/a.jsonl", activate: false });
		// 入表且落在锚点右侧，但当前仍是 a（用户刚点的那一个不被迟到结果抢走）
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual([
			"/a.jsonl",
			"/late.jsonl",
			"/b.jsonl",
		]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/a.jsonl");

		// 已存在的成员 + activate:false：也不能把当前从 c 改回它
		useSessionWorkspaceStore.getState().setActive("/b.jsonl");
		useSessionWorkspaceStore.getState().addMember(member("a"), { activate: false });
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/b.jsonl");
	});

	it("removeMember：返回接替者与「是否当前成员」（调用方据此决定导航）", () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b", "c"]) store.addMember(member(id));
		const remove = (key: string) => useSessionWorkspaceStore.getState().removeMember(key);
		useSessionWorkspaceStore.getState().setActive("/b.jsonl");
		// 移出当前成员 b → wasActive 且接替者 = 右邻 c
		expect(remove("/b.jsonl")).toEqual({ removed: member("b"), wasActive: true, next: member("c") });
		// 移出非当前成员 a → 不导航（wasActive:false）
		expect(remove("/a.jsonl")).toEqual({ removed: member("a"), wasActive: false, next: null });
		// 移出当前成员 c 但已是最后一条 → wasActive 且无接替者（调用方回新会话页）
		expect(remove("/c.jsonl")).toEqual({ removed: member("c"), wasActive: true, next: null });
		// 键不在工作区 → null
		expect(remove("/gone.jsonl")).toBeNull();
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
	});

	it("移出当前成员：右邻优先、否则左邻、最后一条 → 空态（不调后端、不取消置顶）", () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b", "c"]) store.addMember(member(id));

		// 移出 active c（末尾）→ 左邻 b
		useSessionWorkspaceStore.getState().removeMember("c");
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/b.jsonl");

		// 移出 active b → 右邻没了（c 已走）→ 左邻 a
		useSessionWorkspaceStore.getState().removeMember("/b.jsonl");
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/a.jsonl"]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/a.jsonl");

		// 移出非 active 成员只改成员
		useSessionWorkspaceStore.getState().addMember(member("d"), { anchorFile: "/a.jsonl" });
		useSessionWorkspaceStore.getState().setActive("/a.jsonl");
		useSessionWorkspaceStore.getState().removeMember("d");
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/a.jsonl");

		// 最后一条 → 空态（由调用方决定是否导航；store 自身不导航）
		useSessionWorkspaceStore.getState().removeMember("/a.jsonl");
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
	});

	it("移出中间成员时右邻优先（当前是 b、c 也在）", () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b", "c"]) store.addMember(member(id));
		useSessionWorkspaceStore.getState().setActive("/b.jsonl");
		useSessionWorkspaceStore.getState().removeMember("/b.jsonl");
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/c.jsonl");
	});

	it("setActive：只切当前，不动顺序；未知键/空态无副作用", () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b"]) store.addMember(member(id));
		const members = useSessionWorkspaceStore.getState().members;

		useSessionWorkspaceStore.getState().setActive("/a.jsonl");
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/a.jsonl");
		// 读侧引用稳定：切换只改 activeFile，members 引用不变（避免无谓重渲染）
		expect(useSessionWorkspaceStore.getState().members).toBe(members);

		useSessionWorkspaceStore.getState().setActive("ghost");
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/a.jsonl");

		useSessionWorkspaceStore.getState().setActive(null);
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/a.jsonl", "/b.jsonl"]);
	});

	it("moveMember：拖拽重排只改顺序与 activeFile（active 不跟着跑）", async () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b", "c"]) store.addMember(member(id));
		useSessionWorkspaceStore.getState().setActive("/a.jsonl");

		useSessionWorkspaceStore.getState().moveMember("c", "a");
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual([
			"/c.jsonl",
			"/a.jsonl",
			"/b.jsonl",
		]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBe("/a.jsonl");
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: {
					sessionWorkspace: { files: ["/c.jsonl", "/a.jsonl", "/b.jsonl"], activeFile: "/a.jsonl" },
				},
			}),
		);
	});

	it("prune：磁盘被删/读不到的成员剔除；0 消息会话只有计划路径 → 同样剔除", async () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b", "c"]) store.addMember(member(id));
		// 磁盘目录里只有 a（b 被外部删除、c 是 0 消息会话的计划路径，文件还没生成）
		const onDisk = new Set(["/a.jsonl"]);
		useSessionWorkspaceStore.getState().prune((m) => onDisk.has(m.file));
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/a.jsonl"]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: ["/a.jsonl"], activeFile: null } },
			}),
		);
	});

	it("prune 无变化时不写盘", () => {
		useSessionWorkspaceStore.getState().addMember(member("a"));
		vi.clearAllMocks();
		useSessionWorkspaceStore.getState().prune(() => true);
		expect(piMock.saveUiState).not.toHaveBeenCalled();
	});

	it("replaceAll：清洗成员、activeFile 越界归 null", async () => {
		useSessionWorkspaceStore
			.getState()
			.replaceAll([member("a"), { file: "/a.jsonl", sessionId: "x" }, null], "/gone.jsonl");
		expect(useSessionWorkspaceStore.getState().members).toEqual([member("a")]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: ["/a.jsonl"], activeFile: null } },
			}),
		);
	});

	it("replaceAll：重复 sessionId 不同 file（脏快照）只落一条，不生成重复胶囊", async () => {
		useSessionWorkspaceStore
			.getState()
			.replaceAll(
				[{ file: "/a.jsonl", sessionId: "s" }, { file: "/b.jsonl", sessionId: "s" }, member("t")],
				"/b.jsonl",
			);
		expect(useSessionWorkspaceStore.getState().members).toEqual([member("s", "/a.jsonl"), member("t")]);
		// 被去重掉的 /b.jsonl 不再是成员 → activeFile 归 null（不变式：activeFile ∈ 成员）
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: ["/a.jsonl", "/t.jsonl"], activeFile: null } },
			}),
		);
	});

	it("持久化合并：连续动作只把最后意图写出，不出现回退的中间态", async () => {
		const store = useSessionWorkspaceStore.getState();
		for (const id of ["a", "b", "c"]) store.addMember(member(id));
		await vi.waitFor(() => expect(piMock.saveUiState).toHaveBeenCalled());

		const lengths = piMock.saveUiState.mock.calls.map(
			(call) => (call[0] as SaveUiStatePayload).state.sessionWorkspace.files.length,
		);
		expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
		const last = piMock.saveUiState.mock.calls.at(-1)?.[0] as SaveUiStatePayload | undefined;
		expect(last?.state.sessionWorkspace).toEqual({
			files: ["/a.jsonl", "/b.jsonl", "/c.jsonl"],
			activeFile: "/c.jsonl",
		});
	});

	it("clear：清空 + 换代次（在途恢复据此放弃）；本就空时只换代次不写盘", async () => {
		useSessionWorkspaceStore.getState().addMember(member("a"));
		const epoch = useSessionWorkspaceStore.getState().epoch;
		useSessionWorkspaceStore.getState().clear();
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
		expect(useSessionWorkspaceStore.getState().epoch).toBe(epoch + 1);
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: [], activeFile: null } },
			}),
		);

		vi.clearAllMocks();
		useSessionWorkspaceStore.getState().clear();
		expect(useSessionWorkspaceStore.getState().epoch).toBe(epoch + 2);
		expect(piMock.saveUiState).not.toHaveBeenCalled();
	});
});

describe("显示开关联动（双关 = 清空 + 停止采集）", () => {
	it("顶栏开（默认）时记录；两个都关时不记录", () => {
		expect(isWorkspaceRecording()).toBe(true);
		useUiPreferencesStore.setState({ barSessionsVisible: false, sessionRailEnabled: false });
		expect(isWorkspaceRecording()).toBe(false);
		expect(useSessionWorkspaceStore.getState().addMember(member("a"))).toBe(false);
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
	});

	it("只关一处不清空（轨道关、顶栏开 → 成员保留）", () => {
		useSessionWorkspaceStore.getState().addMember(member("a"));
		useUiPreferencesStore.getState().setBarSessionsVisible(true);
		useUiPreferencesStore.getState().setSessionRailEnabled(false);
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/a.jsonl"]);

		// 顶栏关、轨道开 → 也不清
		useUiPreferencesStore.getState().setSessionRailEnabled(true);
		useUiPreferencesStore.getState().setBarSessionsVisible(false);
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/a.jsonl"]);
	});

	it("关掉最后一处 → 同步清空 + 换代次 + 落盘空快照（不导航，store 不管导航）", async () => {
		useSessionWorkspaceStore.getState().addMember(member("a"));
		useUiPreferencesStore.getState().setSessionRailEnabled(false);
		expect(isWorkspaceRecording()).toBe(true);
		const epoch = useSessionWorkspaceStore.getState().epoch;

		// 此时顶栏仍开着：关掉顶栏 = 最后一处
		useUiPreferencesStore.getState().setBarSessionsVisible(false);
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
		expect(useSessionWorkspaceStore.getState().activeFile).toBeNull();
		expect(useSessionWorkspaceStore.getState().epoch).toBe(epoch + 1);
		await vi.waitFor(() =>
			expect(piMock.saveUiState).toHaveBeenLastCalledWith({
				state: { sessionWorkspace: { files: [], activeFile: null } },
			}),
		);
	});

	it("重新开启从空开始（不会把清空前的成员复活）", () => {
		useSessionWorkspaceStore.getState().addMember(member("a"));
		useUiPreferencesStore.getState().setBarSessionsVisible(false);
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);

		useUiPreferencesStore.getState().setSessionRailEnabled(true);
		expect(useSessionWorkspaceStore.getState().members).toEqual([]);
		// 重新开启后从下一次「用户打开会话」开始记
		expect(useSessionWorkspaceStore.getState().addMember(member("b"))).toBe(true);
		expect(filesOf(useSessionWorkspaceStore.getState().members)).toEqual(["/b.jsonl"]);
	});
});
