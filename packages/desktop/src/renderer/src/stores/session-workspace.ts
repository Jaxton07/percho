import type { SessionMeta, SessionWorkspaceSnapshot } from "@percho/shared";
import { create } from "zustand";
import { getPi } from "../api";
import { isPrimaryNavigationSession } from "../lib/session-visibility";
import { useUiPreferencesStore } from "./ui-preferences";

/**
 * 临时会话工作区（产品定义见 `.local/agent-work/spec/session-workspace.md`）。
 *
 * 它是**独立于 `sessions` 与 `pinnedSessions` 的一份有序成员表**：
 * - 不能用 `sessions`（后端装载集合）当成员事实源：内存策略会把非活跃会话卸载掉，胶囊会凭空消失；
 * - 也不能用 `pinnedSessions`（那是长期收藏标记，写进去就复发「置顶与临时切换混成一件事」的老问题）。
 *
 * 持久化只存**会话文件路径**（+ 最后查看的那条）：重启只按需加载 `activeFile`，其余成员靠历史目录投影
 * 画胶囊。内存成员同时带 `sessionId`（去重副键 + UI 展示集解析）。
 *
 * 模块依赖方向：本模块 → `ui-preferences`（只读开关）。**反向 import 会形成模块环**（项目硬约束），
 * 所以「两个入口都关掉 → 清空」由本模块底部的订阅驱动，而不是开关 setter 调回来。
 */
export interface WorkspaceMember {
	/** 会话文件路径（trim 规范化；持久化键） */
	file: string;
	/** 会话 id（与 file 一对一；判重副键与展示集解析用） */
	sessionId: string;
}

const EMPTY_SNAPSHOT: SessionWorkspaceSnapshot = { files: [], activeFile: null };

/** 文件路径规范化为成员键：trim 后为空 → null（脏条目一律不记） */
export function workspaceFileKey(file: string | null | undefined): string | null {
	if (typeof file !== "string") return null;
	const trimmed = file.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * 成员定位：**file 优先、sessionId 兜底**。
 * 两把键都认是因为两处调用方拿到的键不同：持久化/恢复只有文件路径，UI 的 × 与拖拽只有 sessionId。
 * 命中任一即视为同一成员 —— 这是「重复文件/重复 id 都只有一条记录」不变式的落点。
 */
export function memberIndexOf(members: readonly WorkspaceMember[], key: string | null | undefined): number {
	const file = workspaceFileKey(key);
	if (file === null) return -1;
	const byFile = members.findIndex((m) => m.file === file);
	if (byFile >= 0) return byFile;
	return members.findIndex((m) => m.sessionId === file);
}

export function resolveMember(
	members: readonly WorkspaceMember[],
	key: string | null | undefined,
): WorkspaceMember | null {
	const index = memberIndexOf(members, key);
	return index < 0 ? null : (members[index] ?? null);
}

/**
 * 插入新成员到 `anchorFile` 的**右侧**（spec：新成员右插；无锚点/锚点不在工作区 → 追加末尾）。
 * 已存在（按下标判定）时返回**同一引用**：已加入的成员只激活、不挪位，顺序不跳动。
 */
export function insertMember(
	members: readonly WorkspaceMember[],
	member: WorkspaceMember,
	anchorFile: string | null,
): readonly WorkspaceMember[] {
	if (memberIndexOf(members, member.file) >= 0 || memberIndexOf(members, member.sessionId) >= 0) {
		return members;
	}
	const at = memberIndexOf(members, anchorFile);
	if (at < 0) return [...members, member];
	return [...members.slice(0, at + 1), member, ...members.slice(at + 1)];
}

/** 移出后的新 active：**右邻优先**，否则左邻，都没有（移除最后一条）→ null（由调用方去新会话页） */
export function nextActiveFile(
	members: readonly WorkspaceMember[],
	removedFile: string | null | undefined,
): string | null {
	const index = memberIndexOf(members, removedFile);
	if (index < 0) return null;
	return (members[index + 1] ?? members[index - 1])?.file ?? null;
}

/** 拖拽重排：把 `fromKey` 挪到 `toKey` 的位置（顶栏与轨道拖拽用）；任一键不存在则同引用返回 */
export function moveMember(
	members: readonly WorkspaceMember[],
	fromKey: string | null | undefined,
	toKey: string | null | undefined,
): readonly WorkspaceMember[] {
	const from = memberIndexOf(members, fromKey);
	const to = memberIndexOf(members, toKey);
	if (from < 0 || to < 0 || from === to) return members;
	const next = [...members];
	const [moved] = next.splice(from, 1);
	if (!moved) return members;
	next.splice(to, 0, moved);
	return next;
}

/**
 * 失效项裁剪：会话在磁盘被删（本应用或外部）、或路径已读不到 → 移出工作区。
 * 0 消息会话只有**计划路径**、磁盘上还没有文件，冷启动对账时同样落进这里被剔除（spec：不造空白会话文件）。
 */
export function pruneMembers(
	members: readonly WorkspaceMember[],
	isAlive: (member: WorkspaceMember) => boolean,
): readonly WorkspaceMember[] {
	const next = members.filter(isAlive);
	return next.length === members.length ? members : next;
}

/** 内存成员 → 持久化快照（`activeFile` 不在成员里则落 null，守住「activeFile ∈ files」不变式） */
export function workspaceSnapshotOf(
	members: readonly WorkspaceMember[],
	activeFile: string | null,
): SessionWorkspaceSnapshot {
	const files = members.map((m) => m.file);
	return { files, activeFile: activeFile !== null && files.includes(activeFile) ? activeFile : null };
}

/** 清洗任意来源的成员数组（恢复/测试用）：丢掉无效项，**按 file 与 sessionId 双键去重保序**（保留首次出现） */
export function normalizeMembers(value: unknown): WorkspaceMember[] {
	if (!Array.isArray(value)) return [];
	const files = new Set<string>();
	const ids = new Set<string>();
	const out: WorkspaceMember[] = [];
	for (const item of value) {
		const candidate = item as Partial<WorkspaceMember> | null;
		const file = workspaceFileKey(candidate?.file);
		const sessionId = typeof candidate?.sessionId === "string" ? candidate.sessionId.trim() : "";
		// 双键去重：同一路径或同一会话 id 都只留一条 —— 不变式守在**入口**，
		// 否则「同一会话两条记录」会一路传到胶囊列表（同一个 id 画两个胶囊）。
		// 与 addMember 同口径：file 是持久化主键、sessionId 是副键。
		if (file === null || sessionId === "" || files.has(file) || ids.has(sessionId)) continue;
		files.add(file);
		ids.add(sessionId);
		out.push({ file, sessionId });
	}
	return out;
}

/**
 * 展示集（读侧）：按成员顺序把 meta 解析出来 —— `tabs`（已装载，运行态最新）优先，`history`
 * （会话目录投影）兜底，所以**被内存策略卸载的成员照样出胶囊**。两边都查不到（会话已删）则跳过；
 * 只读子代理检视（subagent 产物）不进工作区，与左栏同一道判据。
 *
 * 按 sessionId 再去重一次是**纵深防御**（不变式由 `normalizeMembers` / `addMember` 在入口守住），
 * 保证任何旁路数据都不会让同一个会话出两个胶囊。
 */
export function resolveWorkspaceSessions(
	members: readonly WorkspaceMember[],
	tabs: readonly SessionMeta[],
	history: readonly SessionMeta[],
): SessionMeta[] {
	const byId = new Map<string, SessionMeta>();
	for (const s of history) byId.set(s.sessionId, s);
	for (const s of tabs) byId.set(s.sessionId, s);
	const seen = new Set<string>();
	const out: SessionMeta[] = [];
	for (const member of members) {
		if (seen.has(member.sessionId)) continue;
		seen.add(member.sessionId);
		const meta = byId.get(member.sessionId) ?? history.find((s) => s.sessionFile === member.file);
		if (meta && isPrimaryNavigationSession(meta)) out.push(meta);
	}
	return out;
}

/**
 * 持久化快照 → 内存成员（启动恢复用）：按**文件路径**解析（持久化只有路径，没有 id），
 * 存在性只认 `history`（磁盘目录投影）：已删/外部移除或只读子代理 → 不生成成员（失效裁剪）。
 * **不看 `tabs`**（内存已装载）：那里的 0 消息会话只有计划路径、磁盘上没有文件，拿它当存在性依据
 * 会把不可恢复的成员复活。
 */
export function resolveMembersByFile(
	files: readonly string[],
	history: readonly SessionMeta[],
): WorkspaceMember[] {
	const byFile = new Map<string, SessionMeta>();
	for (const s of history) if (s.sessionFile) byFile.set(s.sessionFile, s);
	const seen = new Set<string>();
	const out: WorkspaceMember[] = [];
	for (const file of files) {
		const meta = byFile.get(file);
		if (!meta || seen.has(meta.sessionId) || !isPrimaryNavigationSession(meta)) continue;
		seen.add(meta.sessionId);
		out.push({ file, sessionId: meta.sessionId });
	}
	return out;
}

/** 是否在采集成员：**两个显示入口都关掉就停止记录**（spec：双关 = 清空并停止采集） */
export function isWorkspaceRecording(): boolean {
	const prefs = useUiPreferencesStore.getState();
	return prefs.barSessionsVisible || prefs.sessionRailEnabled;
}

/**
 * 持久化：**单写者 + 只保留最后意图**。
 *
 * 不能每次状态变化各自 fire-and-forget 一次 `saveUiState`：连续动作（打开 A 再打开 B、拖拽一串顺序）
 * 会发出多次写请求，最终落盘顺序与内存状态只能靠运气对齐。这里永远只挂「最新一份快照」，
 * 串行 flush —— 文件最终内容恒等于最后一次内存状态，中间态不会被写出去（也确实不值得写）。
 */
let pendingSnapshot: SessionWorkspaceSnapshot | null = null;
let flushing = false;

function schedulePersist(snapshot: SessionWorkspaceSnapshot): void {
	pendingSnapshot = snapshot;
	if (flushing) return;
	flushing = true;
	void (async () => {
		try {
			while (pendingSnapshot) {
				const current = pendingSnapshot;
				pendingSnapshot = null;
				try {
					await getPi().saveUiState({ state: { sessionWorkspace: current } });
				} catch (error) {
					// 偏好丢失不影响本次使用（与 ui-preferences 同策略：不弹 toast、不打断动作）
					console.error("工作区持久化失败", error);
				}
			}
		} finally {
			flushing = false;
		}
	})();
}

interface SessionWorkspaceStore {
	/** 有序成员（同一 file 只出现一次；`activeFile ∈ members` 恒成立） */
	members: readonly WorkspaceMember[];
	/** 最后查看的成员文件；null = 当前不在任何工作区会话（如新会话页 draft） */
	activeFile: string | null;
	/**
	 * **最近一次真正看过的成员**（内存态，不落盘）。
	 *
	 * 为什么需要它：新会话页（draft）上 `activeSessionId === null` → `activeFile` 按 spec 必须是 null
	 * （重启就该回到新会话页），但「从哪个会话点的新建」这个信息不能丢 —— 在那里转正出来的新会话
	 * 要插在**你刚才看的那个会话**右侧（spec：新成员插在当前成员右侧），否则只能追加到末尾，
	 * 表现为「新建的胶囊跑到最后」。
	 */
	recentFile: string | null;
	/**
	 * 代次令牌：`clear()` 时自增。**冷启动恢复/在途打开的异步结果落地前必须比对**，
	 * 否则用户关闭开关清空工作区后，迟迟返回的恢复结果会把成员「复活」。
	 */
	epoch: number;
	/**
	 * 当前**插入锚点**：优先当前成员（`activeFile`），为空时回落「最近看过的成员」（`recentFile`）。
	 * 调用方（如用户入口 `projects.openSession`）在导航**之前**取一次即可，不必自己拼规则。
	 */
	anchorFile: () => string | null;
	/**
	 * 用户打开会话时记入工作区：已存在只激活、不挪位；新成员插在当前成员（`anchorFile`，
	 * 缺省 = `activeFile`）右侧，无锚点追加末尾。`activate: false`（迟到结果）只入表不抢 activeFile。
	 * 返回 false = 没记（双关停止采集 / 文件或 id 缺失）。
	 */
	addMember: (
		input: { file?: string | null; sessionId?: string | null },
		opts?: { anchorFile?: string | null; activate?: boolean },
	) => boolean;
	/**
	 * 移出工作区（≠ 关闭会话：不调后端、不取消置顶、不中断任务）；键可为 file 或 sessionId。
	 * 返回 `{ removed, wasActive, next }`：`wasActive` 决定调用方要不要导航（工作区动作本身**从不导航**），
	 * `next` = 接替的成员（右邻优先），`null` = 没有接替者（调用方回新会话页）。键不在工作区 → 返回 null。
	 */
	removeMember: (key: string) => {
		removed: WorkspaceMember;
		wasActive: boolean;
		next: WorkspaceMember | null;
	} | null;
	/** 只切当前成员，不动顺序；键可为 file 或 sessionId，null = 空态 */
	setActive: (key: string | null) => void;
	/** 拖拽重排工作区顺序 */
	moveMember: (fromKey: string, toKey: string) => void;
	/** 恢复落盘快照（冷启动对账后调用）：一次写入成员与 active，自动清洗 */
	replaceAll: (members: unknown, activeFile: string | null) => void;
	/**
	 * 冷启动恢复落地：把快照解析结果**并入**当前工作区，不直接覆盖。
	 *
	 * 为什么不能直接 replaceAll：恢复链有两次 await（读偏好 + 读目录），用户完全可能在这期间从左栏
	 * 打开会话 —— 那是一个真实的新成员，覆盖会把它连带丢掉（而且会跟着旧快照一起落盘）。
	 * 语义：快照成员按原顺序在前，恢复期间新加入的按原相对顺序接在后面；`activeFile` 优先保留
	 * 用户当前的（他正在看的），否则才用快照里的。
	 */
	hydrateFromSnapshot: (members: unknown, activeFile: string | null) => void;
	/** 磁盘对账裁剪：失效项移出；被裁掉的正是 active 时 → 空态 */
	prune: (isAlive: (member: WorkspaceMember) => boolean) => void;
	/** 清空成员（双关、或用户显式清空）：**不导航、不关会话**，只换代次 */
	clear: () => void;
}

export const useSessionWorkspaceStore = create<SessionWorkspaceStore>((set, get) => ({
	members: [],
	activeFile: null,
	recentFile: null,
	epoch: 0,

	anchorFile: () => get().activeFile ?? get().recentFile,

	addMember: (input, opts) => {
		if (!isWorkspaceRecording()) return false;
		const file = workspaceFileKey(input.file);
		const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
		// 只记「能对应磁盘历史的真实会话」：路径与 id 都拿不到就不记（防御脏条目）
		if (file === null || sessionId === "") return false;
		const activate = opts?.activate !== false;

		const { members, activeFile, recentFile } = get();
		// 判重：file 优先、sessionId 兜底（同一会话若换了别名路径，仍只保留原来那条记录）
		const byFile = memberIndexOf(members, file);
		const existing = byFile >= 0 ? byFile : memberIndexOf(members, sessionId);
		if (existing >= 0) {
			// 已加入：只激活、不挪位（重复打开同一会话不能让顺序跳动）
			const member = members[existing];
			if (!member || !activate || member.file === activeFile) return true;
			set({ activeFile: member.file, recentFile: member.file });
			schedulePersist(workspaceSnapshotOf(members, member.file));
			return true;
		}

		// `anchorFile` 显式给了 null = 不锚，追加末尾；没给 = 以「当前成员」为锚
		const anchor = opts && "anchorFile" in opts ? (opts.anchorFile ?? null) : (activeFile ?? recentFile);
		const next = insertMember(members, { file, sessionId }, anchor);
		const nextActive = activate ? file : activeFile;
		// `recentFile` 跟随「最后一次真正看过的成员」：激活时更新；迟到结果（activate:false）不动它
		set({ members: next, activeFile: nextActive, recentFile: activate ? file : recentFile });
		schedulePersist(workspaceSnapshotOf(next, nextActive));
		return true;
	},

	removeMember: (key) => {
		const { members, activeFile, recentFile } = get();
		const target = resolveMember(members, key);
		if (!target) return null;
		const wasActive = activeFile === target.file;
		// 右邻优先、否则左邻、都没有 → null（调用方据此回新会话页）
		const fallback = nextActiveFile(members, target.file);
		const next = members.filter((m) => m.file !== target.file);
		const nextActive = wasActive ? fallback : activeFile;
		// 被移出的正好是「最近看过」的那个 → 交给接替者（否则锚点会挂在一个不存在的成员上）
		const nextRecent = recentFile === target.file ? fallback : recentFile;
		set({ members: next, activeFile: nextActive, recentFile: nextRecent });
		schedulePersist(workspaceSnapshotOf(next, nextActive));
		// `next` 只在「被移出的正是当前成员」时有意义（否则当前成员没变，谈不上接替）
		const successor = wasActive ? (next.find((m) => m.file === nextActive) ?? null) : null;
		return { removed: target, wasActive, next: successor };
	},

	setActive: (key) => {
		const { members, activeFile } = get();
		if (key === null) {
			if (activeFile === null) return;
			set({ activeFile: null });
			schedulePersist(workspaceSnapshotOf(members, null));
			return;
		}
		const target = resolveMember(members, key);
		if (!target || target.file === activeFile) return;
		// 顺序不动（切换不是排序意图）；recentFile 记住「最后真正看过的成员」供锚点回落
		set({ activeFile: target.file, recentFile: target.file });
		schedulePersist(workspaceSnapshotOf(members, target.file));
	},

	moveMember: (fromKey, toKey) => {
		const { members, activeFile } = get();
		const next = moveMember(members, fromKey, toKey);
		if (next === members) return;
		set({ members: next });
		schedulePersist(workspaceSnapshotOf(next, activeFile));
	},

	replaceAll: (members, activeFile) => {
		const next = normalizeMembers(members);
		const key = workspaceFileKey(activeFile);
		const nextActive = key !== null && next.some((m) => m.file === key) ? key : null;
		set({ members: next, activeFile: nextActive, recentFile: nextActive });
		schedulePersist(workspaceSnapshotOf(next, nextActive));
	},

	hydrateFromSnapshot: (members, activeFile) => {
		const saved = normalizeMembers(members);
		const { members: current, activeFile: currentActive } = get();
		// 恢复期间用户自己开的（不在快照里的）按原相对顺序追加在后
		const savedFiles = new Set(saved.map((m) => m.file));
		const savedIds = new Set(saved.map((m) => m.sessionId));
		const added = current.filter((m) => !savedFiles.has(m.file) && !savedIds.has(m.sessionId));
		const merged = [...saved, ...added];
		const key = workspaceFileKey(activeFile);
		// 当前指针优先（用户正在看的），失效/缺失才回落到快照里的 activeFile
		const nextActive =
			currentActive !== null && merged.some((m) => m.file === currentActive)
				? currentActive
				: key !== null && merged.some((m) => m.file === key)
					? key
					: null;
		// recentFile 只在恢复出的指针有效时跟随；用户接管（null 指针）时保留内存里的旧值（通常为 null）
		set({ members: merged, activeFile: nextActive, recentFile: nextActive ?? get().recentFile });
		schedulePersist(workspaceSnapshotOf(merged, nextActive));
	},

	prune: (isAlive) => {
		const { members, activeFile, recentFile } = get();
		const next = pruneMembers(members, isAlive);
		if (next === members) return;
		const nextActive = next.some((m) => m.file === activeFile) ? activeFile : null;
		const nextRecent = recentFile !== null && next.some((m) => m.file === recentFile) ? recentFile : null;
		set({ members: next, activeFile: nextActive, recentFile: nextRecent });
		schedulePersist(workspaceSnapshotOf(next, nextActive));
	},

	clear: () => {
		const { members, activeFile, epoch } = get();
		if (members.length === 0 && activeFile === null) {
			// 已经是空的：仍要换代次（在途恢复据此放弃），但没有必要写盘
			set({ epoch: epoch + 1 });
			return;
		}
		set({ members: [], activeFile: null, recentFile: null, epoch: epoch + 1 });
		schedulePersist(EMPTY_SNAPSHOT);
	},
}));

/**
 * 开关联动的**唯一触发点**：两个显示入口都关掉 → 同步清空工作区（清空 ≠ 关闭会话，也不改当前聊天）。
 *
 * 订阅（而不是在开关 setter 里调回来）是为了守住单向依赖：本模块 → ui-preferences。
 * 代价是「本模块必须被 import 才会生效」——`stores/sessions.ts` 在阶段 2 起 import 它，
 * 只要 App 起来就一定在（settings 面板也只在 App 里能点）。
 */
useUiPreferencesStore.subscribe((state, prev) => {
	if (
		state.barSessionsVisible === prev.barSessionsVisible &&
		state.sessionRailEnabled === prev.sessionRailEnabled
	) {
		return;
	}
	if (state.barSessionsVisible || state.sessionRailEnabled) return;
	useSessionWorkspaceStore.getState().clear();
});
