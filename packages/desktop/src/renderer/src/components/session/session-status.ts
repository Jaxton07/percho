import type { SessionMeta } from "@percho/shared";
import { isDailyCwd } from "../../lib/daily";
import { useTranscriptStore } from "../../stores/transcript";

/** 会话状态（优先级递减）：等待审批/应答 > 工作中 > 完成未读 > 空闲。顶栏胶囊与左侧轨道共用 */
export type SessionStatus = "attention" | "working" | "done" | "idle";

/** 订阅单个会话的运行状态（selector 返回字符串原始值，引用稳定不触发多余渲染） */
export function useSessionStatus(sessionId: string): SessionStatus {
	return useTranscriptStore((s): SessionStatus => {
		const entry = s.bySession[sessionId];
		if (!entry) return "idle";
		// 有待应答交互（权限或扩展对话框，D6 权限优先）即 amber 呼吸点（extension-dialogs 画板⑧）
		if (entry.pendingPermissions.length > 0 || entry.pendingDialogs.length > 0) return "attention";
		if (entry.agentActive) return "working";
		if (entry.unseenCompletion) return "done";
		return "idle";
	});
}

/** 会话显示标题：用户设置/自动生成名 → 项目目录末级（日常空间 → 本地化「日常」）→ 未命名占位 */
export function sessionTitle(session: SessionMeta, untitledLabel: string, dailyLabel?: string): string {
	return (
		session.name ??
		(isDailyCwd(session.cwd) ? dailyLabel : undefined) ??
		session.cwd.split("/").filter(Boolean).pop() ??
		untitledLabel
	);
}

/** 项目目录末级名（空串 = 无，如 cwd 为根路径） */
export function sessionProjectDir(session: SessionMeta): string {
	return session.cwd.split("/").filter(Boolean).pop() ?? "";
}

/** 头像字母 = 项目名（cwd 最后一段）首字母，与会话标题无关 */
export function sessionLetter(session: SessionMeta): string {
	return sessionProjectDir(session)[0] ?? "P";
}

/**
 * 会话头像底色（顶栏胶囊 / 左侧轨道 / 悬浮会话列表三处共用同一套语义，改这里三处一起变）：
 * 只读子代理 > 审批等待 > 工作中 > 日常空间（白底咖啡，余态） > 当前会话 > 其余。
 * 头像字形不在这里（JSX 在 components/session/SessionAvatar.tsx）。
 */
export function sessionAvatarClass(
	status: SessionStatus,
	{ isActive, daily, readOnly = false }: { isActive: boolean; daily: boolean; readOnly?: boolean },
): string {
	if (readOnly) return "bg-accent text-on-accent";
	if (status === "attention") return "bg-amber-500 text-on-ink";
	if (status === "working") return "bg-ink text-on-ink tab-avatar-working";
	if (daily) return "border border-border-strong bg-canvas text-ink";
	return isActive ? "bg-ink text-on-ink" : "bg-ink-faint text-on-ink";
}
