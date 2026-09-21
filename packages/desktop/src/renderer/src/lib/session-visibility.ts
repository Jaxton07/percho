import type { SessionMeta } from "@percho/shared";

/**
 * 会话是否属于「导航可见集合」（左栏项目组 / 搜索 / 项目计数 / 顶栏胶囊）。
 *
 * 临时 subagent 的检视会话（`readOnly: true`）**只从导航投影里过滤**：它必须继续留在
 * `sessions` store 里（本地事件、transcript、只读判定、关闭/GC 都靠它），只是不该出现在
 * 左栏的分组与计数、也不该出现在顶栏。判据收在这一处，导航派生（`lib/sidebar-groups`）
 * 与顶栏兜底（`stores/sessions.selectBarSessions`）共用，避免两处各写一份。
 */
export function isPrimaryNavigationSession(session: SessionMeta): boolean {
	return session.readOnly !== true;
}
