import type { SessionMeta } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { RenamePopover } from "../session/RenamePopover";
import {
	copySessionDiagnostics,
	renameSession,
	sessionMenuItems,
	sidebarMenuKind,
} from "../session/session-menu";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu } from "../ui/ContextMenu";
import type { MenuAnchor } from "../ui/place-menu";

/**
 * 左侧栏会话行的右键菜单状态机（菜单 → 改名气泡 → 删除确认三层，都在这里，行组件只管文案与状态点）。
 * 「能不能弹」与「有哪些项」跟顶栏胶囊共用 `session-menu.tsx`，两处行为不会漂移。
 * 返回的 `element` 由分组挂到自己的子树里（portal 到 body，放哪都不影响定位）。
 */
export function useSessionMenu() {
	const t = useT();
	const pinnedSessions = useUiPreferencesStore((s) => s.pinnedSessions);
	const deleteSession = useProjectsStore((s) => s.deleteSession);
	const [menu, setMenu] = useState<{ session: SessionMeta; anchor: MenuAnchor } | null>(null);
	const [renaming, setRenaming] = useState<{ session: SessionMeta; anchor: MenuAnchor } | null>(null);
	const [deleting, setDeleting] = useState<SessionMeta | null>(null);

	const open = (session: SessionMeta, anchor: MenuAnchor) => {
		// 只读子会话 / 找不到会话的判定在纯函数里（sidebarMenuKind，有单测）；none 就不弹菜单
		if (sidebarMenuKind(session) === "none") return;
		setMenu({ session, anchor });
	};

	const element = (
		<>
			{menu && (
				<ContextMenu
					anchor={menu.anchor}
					onClose={() => setMenu(null)}
					items={sessionMenuItems(t, {
						sessionId: menu.session.sessionId,
						pinned: pinnedSessions.includes(menu.session.sessionId),
						onRename: () => setRenaming({ session: menu.session, anchor: menu.anchor }),
						onCopyDiagnostics: () => void copySessionDiagnostics(menu.session),
						onDelete: () => setDeleting(menu.session),
					})}
				/>
			)}
			{renaming && (
				<RenamePopover
					anchor={renaming.anchor}
					value={renaming.session.name ?? ""}
					onCommit={(name) => {
						// 先卸载浮层（退场动画已跑完）再落盘，与顶栏胶囊同一顺序
						setRenaming(null);
						renameSession(renaming.session.sessionId, name);
					}}
					onCancel={() => setRenaming(null)}
				/>
			)}
			{deleting && (
				<ConfirmDialog
					title={t("sessionMenu.deleteTitle")}
					description={t("sessionMenu.deleteDesc")}
					confirmLabel={t("sessionMenu.delete")}
					cancelLabel={t("common.cancel")}
					danger
					onConfirm={() => {
						void deleteSession(deleting);
						setDeleting(null);
					}}
					onCancel={() => setDeleting(null)}
				/>
			)}
		</>
	);

	return { open, element };
}
