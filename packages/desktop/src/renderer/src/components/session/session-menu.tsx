import type { SessionMeta } from "@percho/shared";
import { getPi } from "../../api";
import type { Translate } from "../../i18n";
import { buildDiagnosticsText } from "../../lib/diagnostics";
import { useProjectsStore } from "../../stores/projects";
import { isDraftSessionId, useSessionsStore } from "../../stores/sessions";
import { useToastsStore } from "../../stores/toasts";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { CopyIcon, PencilIcon, PinIcon, TrashIcon } from "../icons";
import type { ContextMenuItem } from "../ui/ContextMenu";

/**
 * 会话菜单的共用规则（顶栏胶囊、悬浮会话列表、左侧栏会话行调同一份，行为必须一致）：
 * 能不能弹、菜单项、以及置顶 / 重命名 / 复制诊断 / 删除四个动作。
 * 为什么单独一个模块：draft（纯前端 id）与只读子会话（后端拒绝写）都要拦、置顶要顺带重排、
 * 重命名失败要弹 toast —— 复制三份迟早漂移。
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

/** 重命名落盘：活跃会话靠 session_info_changed 事件回流，历史会话无事件 → 本地立即更新（幂等）。
 *  两份拷贝都要同步：`sessions`（顶栏胶囊）与 `projects.allSessions`（左栏会话行），
 *  只更新一边会出现「胶囊新名 / 左栏旧名」并存（阶段 3 实测踩到）。 */
export function renameSession(sessionId: string, name: string): void {
	if (!name) return; // 空值 = 保持原名（与系统重命名一致，不报错）
	getPi()
		.setSessionName({ sessionId, name })
		.then(() => {
			useSessionsStore.getState().updateSessionName(sessionId, name);
			useProjectsStore.getState().applySessionName(sessionId, name);
		})
		.catch((error) => {
			console.error("重命名失败", error);
			useToastsStore.getState().push("error", "toast.sessionRenameFailed");
		});
}

/** 复制诊断信息（纯文本，用户直接贴给 agent 排查）：剪贴板不可用（权限/非安全上下文）时静默不报错，
 *  成功也不弹 toast —— 与项目页会话行同语义（阶段 3 已把项目页退役，这里是唯一实现） */
export async function copySessionDiagnostics(session: SessionMeta): Promise<void> {
	try {
		// 版本经既有 AppGetInfo 通道取（无专用 getVersion IPC）；失败不阻塞其余字段
		const info = await getPi()
			.getAppInfo()
			.catch(() => null);
		const text = buildDiagnosticsText(session, {
			platform: getPi().platform,
			appVersion: info?.version ?? "unknown",
		});
		await navigator.clipboard.writeText(text);
	} catch {
		/* 剪贴板不可用：静默 */
	}
}

/** 菜单项：重命名 / 置顶 / 复制诊断 / 删除会话（调用方保证会话可写，见 canOpenSessionMenu）。
 *  后两项只在调用方传了处理器时出现（顶栏胶囊菜单只给前两项），删除走分隔线分组 + 危险红。 */
export function sessionMenuItems(
	t: Translate,
	options: {
		sessionId: string;
		pinned: boolean;
		onRename: () => void;
		onCopyDiagnostics?: () => void;
		onDelete?: () => void;
	},
): ContextMenuItem[] {
	return [
		{ key: "rename", label: t("tabbar.rename"), icon: <PencilIcon size={13} />, onSelect: options.onRename },
		{
			key: "pin",
			label: options.pinned ? t("tabbar.unpin") : t("tabbar.pin"),
			icon: <PinIcon size={13} />,
			onSelect: () => toggleSessionPin(options.sessionId),
		},
		...(options.onCopyDiagnostics
			? [
					{
						key: "copy",
						label: t("sessionMenu.copyDiagnostics"),
						icon: <CopyIcon size={13} />,
						onSelect: options.onCopyDiagnostics,
					} satisfies ContextMenuItem,
				]
			: []),
		...(options.onDelete
			? [
					{
						key: "delete",
						label: t("sessionMenu.delete"),
						icon: <TrashIcon size={13} />,
						separatorBefore: true,
						danger: true,
						onSelect: options.onDelete,
					} satisfies ContextMenuItem,
				]
			: []),
	];
}
