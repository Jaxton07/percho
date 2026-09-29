import { getPi } from "../api";
import { initDailyDir } from "../lib/daily";
import { useProjectsStore } from "./projects";
import { isWorkspaceRecording, resolveMembersByFile, useSessionWorkspaceStore } from "./session-workspace";
import {
	currentNavigationToken,
	currentUserIntentToken,
	isLatestNavigation,
	isLatestUserIntent,
	useSessionsStore,
} from "./sessions";

/**
 * 冷启动恢复临时会话工作区（spec：跨重启保留，但**只按需加载 activeFile 一条**）。
 *
 * 为什么不放在 store 里：这条链要同时用到目录投影（projects）与导航（sessions），而这两者都已 import
 * 工作区 store —— 反着依赖会成模块环。本模块是**叶子**，只被 App 的启动链调用。
 *
 * 四条硬约束（都是踩过坑写下的）：
 * 1. **不许靠渲染顺序**：目录快照在这里自己读、自己落库（`adoptCatalog`），不依赖 EmptyState 挂载 ——
 *    恢复出 `activeFile` 的机器上它根本不挂载。
 * 2. **目录读不到就不裁剪、不写盘**：宁可这次不恢复，也不能把有效成员当失效项删掉。
 * 3. **用户在等待期间做的任何事都优先**：自己导航过（含切回新会话页）→ 不抢焦点；自己开过会话 →
 *    新成员**并入**而不是被快照覆盖（`hydrateFromSnapshot`）；关掉两处开关 → 整个放弃（epoch）。
 * 4. **不阻塞开屏**：调用方 fire-and-forget，splash 仍由 loadModels 链收场。
 */
export async function restoreSessionWorkspace(): Promise<void> {
	// 幂等：本次进程已经有成员 = 已恢复过（含 StrictMode 下 effect 重放），或用户已自己开了会话 —— 两种都不该再来一遍
	if (useSessionWorkspaceStore.getState().members.length > 0) return;
	// 双关（顶栏 + 轨道都关）：工作区语义上就是空的，不恢复也不写盘
	if (!isWorkspaceRecording()) return;
	// 用户已经开着会话了（例如恢复链被重放过两次）：不抢焦点、也不必再读偏好
	if (useSessionsStore.getState().activeSessionId !== null) return;
	// 三个取号都必须在**任何 await 之前**：
	// - epoch：用户关掉开关（清空）后，迟到的恢复不得把成员复活
	// - intentToken：用户在等待期间自己选了页面（切会话、回新会话页、项目行、发送转正…），
	//   迟到的恢复不得再开一个会话把页面抢走（`activeSessionId` 分不出「刚切回 draft」与「什么都没做」）
	// - navToken：额外兜一道「领过导航号但没改 activeSessionId」的路径，语义更保守
	const epoch = useSessionWorkspaceStore.getState().epoch;
	const intentToken = currentUserIntentToken();
	const navToken = currentNavigationToken();

	// 偏好读失败（文件损坏/IO 错）：保持空工作区，下次启动自愈（不能把「读不到」当成「用户清空了」去写盘）
	const saved = await getPi()
		.loadUiState()
		.catch(() => null);
	if (!saved) return;
	const snapshot = saved.sessionWorkspace;
	if (!snapshot || snapshot.files.length === 0) return;
	if (useSessionWorkspaceStore.getState().epoch !== epoch) return;

	// 目录快照：**恢复链自己读**（不用 projects.load 的返回值）—— 裁剪判据必须是这次请求拿到的磁盘真值，
	// 而 load 是 latest-wins 的：被抢占时它返回的是别人的账，拿来做失效判定会误删有效成员。
	// 读到之后交 store 采纳（adoptCatalog 会推进序号线，在飞的旧 load 不会把更旧的账盖回来）。
	const catalog = await getPi()
		.listAllSessions()
		.catch(() => null);
	if (!catalog) {
		console.warn("会话目录读取失败，本次启动跳过工作区恢复（保留原快照）");
		return;
	}
	useProjectsStore.getState().adoptCatalog(catalog);
	// 日常目录（胶囊/左栏的日常分组标签要用它）：与目录读取同一批启动工作，失败静默回退
	await initDailyDir().catch(() => null);
	if (useSessionWorkspaceStore.getState().epoch !== epoch) return;

	// 按路径解析：查不到（已删/外部移除）、只读子代理、0 消息会话（只有计划路径、磁盘无文件）都在这里被裁掉。
	// 落地用 hydrate 而不是替换：用户可能在上面两个 await 期间已经开了会话（那是真实的新成员）
	const members = resolveMembersByFile(snapshot.files, catalog);
	const files = members.map((m) => m.file);
	const activeFile =
		snapshot.activeFile !== null && files.includes(snapshot.activeFile) ? snapshot.activeFile : null;
	// 用户在等待期间自己动过手（选了会话、回了新会话页、项目行、发送转正…）→ 「用户优先」：
	// - 工作区成员仍要并入（他开过的会话不能丢，已存的也不能丢）
	// - 但**快照里的 activeFile 不再写回**：否则下次重启会又自动进那个旧会话，把用户当下停的页（如新会话页）抢掉
	// - 不再导航
	const userTookOver =
		useSessionWorkspaceStore.getState().activeFile !== null ||
		!isLatestUserIntent(intentToken) ||
		!isLatestNavigation(navToken);
	useSessionWorkspaceStore.getState().hydrateFromSnapshot(members, userTookOver ? null : activeFile);

	if (activeFile === null || userTookOver) return;
	// 只恢复 activeFile 一条：走既有 open pipeline（内含 single-flight 与最新意图判定），失败只提示、不改工作区
	await useSessionsStore.getState().openFromHistory(activeFile);
}
