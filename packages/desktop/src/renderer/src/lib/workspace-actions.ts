import { useCallback } from "react";
import { useProjectsStore } from "../stores/projects";
import {
	resolveWorkspaceSessions,
	useSessionWorkspaceStore,
	type WorkspaceMember,
} from "../stores/session-workspace";
import { useSessionsStore } from "../stores/sessions";

/**
 * 工作区动作 · ×（移出工作区）：顶栏胶囊与左侧轨道**共用这一份**，避免两处语义漂移
 * （x 不是关会话、不是取消置顶：不调后端、不打断任务）。
 *
 * 被移出的正是当前成员时按 spec 接替：右邻优先、否则左邻、都没有则回新会话页（保留草稿）。
 * 接替者可能是**未加载**成员，所以 meta 从「tabs + 目录投影」解析后再走既有用户入口
 * （`projects.openSession` 内部会按需打开、latest-wins 保护在途竞态）。
 */
export function useWorkspaceRemoval(): (member: WorkspaceMember) => void {
	const removeFromWorkspace = useSessionWorkspaceStore((s) => s.removeMember);

	return useCallback(
		(member: WorkspaceMember) => {
			const result = removeFromWorkspace(member.file);
			// 移出的不是当前成员：只从工作区消失，不动当前聊天（也不导航）
			if (!result?.wasActive) return;
			const next = result.next;
			if (!next) {
				// 移除最后一条 → 回新会话页（store 侧不导航，导航是 UI 的决定）
				useSessionsStore.getState().activateNewSessionDraft();
				return;
			}
			// 接替者的 meta：此刻它已不在 members 里，所以直接按单成员解析（tabs 优先、目录兜底）
			const meta = resolveWorkspaceSessions(
				[next],
				useSessionsStore.getState().sessions,
				useProjectsStore.getState().allSessions,
			)[0];
			// meta 解析不到（文件刚被外部删）→ 也回新会话页，不留在一个不存在的会话上
			if (meta) void useProjectsStore.getState().openSession(meta);
			else useSessionsStore.getState().activateNewSessionDraft();
		},
		[removeFromWorkspace],
	);
}
