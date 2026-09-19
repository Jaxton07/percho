import type { SessionMeta } from "@percho/shared";
import { getPi } from "../../api";
import type { Translate } from "../../i18n";
import { isDraftSessionId, useSessionsStore } from "../../stores/sessions";
import { useToastsStore } from "../../stores/toasts";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { PencilIcon, PinIcon } from "../icons";
import type { ContextMenuItem } from "../ui/ContextMenu";

/**
 * 会话右键菜单的共用规则（顶栏胶囊与悬浮会话列表调同一份，两处行为必须一致）：
 * 能不能弹、菜单项、以及置顶 / 重命名两个动作。
 * 为什么单独一个模块：draft（纯前端 id）与只读子会话（后端拒绝写）都要拦、置顶要顺带重排、
 * 重命名失败要弹 toast —— 复制两份迟早漂移。
 */

/** draft（后端没有该会话）与只读子会话（后端拒绝写）上的动作全会失败 → 干脆不给菜单 */
export function canOpenSessionMenu(session: SessionMeta | undefined): boolean {
	return !!session && !session.readOnly && !isDraftSessionId(session.sessionId);
}

/** 置顶 / 取消置顶：新置顶顺带挪到会话列表最前（视觉上直接进置顶区；draft 无 sessionFile 只参与内存序） */
export function toggleSessionPin(sessionId: string): void {
	const { sessions, reorderSessions } = useSessionsStore.getState();
	const { pinnedSessions, togglePin } = useUiPreferencesStore.getState();
	const first = sessions[0];
	if (!pinnedSessions.includes(sessionId) && first && first.sessionId !== sessionId) {
		reorderSessions(sessionId, first.sessionId);
	}
	togglePin(sessionId);
}

/** 重命名落盘：活跃会话靠 session_info_changed 事件回流，历史会话无事件 → 本地立即更新（幂等） */
export function renameSession(sessionId: string, name: string): void {
	if (!name) return; // 空值 = 保持原名（与系统重命名一致，不报错）
	getPi()
		.setSessionName({ sessionId, name })
		.then(() => useSessionsStore.getState().updateSessionName(sessionId, name))
		.catch((error) => {
			console.error("重命名失败", error);
			useToastsStore.getState().push("error", "toast.sessionRenameFailed");
		});
}

/** 菜单项：重命名 + 置顶/取消置顶（调用方保证会话可写，见 canOpenSessionMenu） */
export function sessionMenuItems(
	t: Translate,
	{ sessionId, pinned, onRename }: { sessionId: string; pinned: boolean; onRename: () => void },
): ContextMenuItem[] {
	return [
		{ key: "rename", label: t("tabbar.rename"), icon: <PencilIcon size={13} />, onSelect: onRename },
		{
			key: "pin",
			label: pinned ? t("tabbar.unpin") : t("tabbar.pin"),
			icon: <PinIcon size={13} />,
			onSelect: () => toggleSessionPin(sessionId),
		},
	];
}
