import type { SessionMeta } from "@percho/shared";
import { getPi } from "../../api";
import type { Translate } from "../../i18n";
import { buildDiagnosticsText } from "../../lib/diagnostics";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { useToastsStore } from "../../stores/toasts";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { CopyIcon, PencilIcon, PinIcon, TrashIcon } from "../icons";
import type { ContextMenuItem } from "../ui/ContextMenu";

/**
 * 会话菜单的共用规则（顶栏胶囊、悬浮会话列表、左侧栏会话行调这一份，行为必须一致；左侧轨道目前不挂菜单）：
 * 能不能弹、菜单项、以及置顶 / 重命名 / 复制诊断 / 删除四个动作。
 * 为什么单独一个模块：只读子会话（后端拒绝写）要拦、重命名失败要弹 toast —— 复制三份迟早漂移。
 *
 * 「置顶 / 取消置顶」的**作用范围只有左栏**（v12 起顶栏胶囊与左侧轨道是临时会话工作区：置顶不改内容、不改顺序）。
 * 注意区分：图钉 **glyph 仍会**出现在顶栏胶囊与轨道展开胶囊上 —— 那是「这个会话被置顶了」的状态展示，不是排序依据。
 *
 * 新会话还没有后端对象、也不进左栏，所以这里不存在「新会话」形态的菜单。
 */

/** 只读子会话（后端拒绝写）上的动作全会失败 → 通用菜单不给；找不到会话同样不给。 */
export function canOpenSessionMenu(session: SessionMeta | undefined): boolean {
	return !!session && !session.readOnly;
}

/**
 * 左栏会话行的右键菜单形态（纯逻辑，便于单测；组件只负责按形态渲染）：
 * - `session`：普通真实会话的完整菜单；
 * - `none`：找不到会话或只读子会话，不给菜单。
 */
export function sidebarMenuKind(session: SessionMeta | undefined): "session" | "none" {
	return canOpenSessionMenu(session) ? "session" : "none";
}

/**
 * 置顶 / 取消置顶：只动 `pinnedSessions`（新置顶自动排最左）。**v12 起置顶只影响左栏**
 * （顶栏胶囊与左侧轨道是临时会话工作区，顺序由工作区成员表定），所以更不需要顺带重排 tabs。
 */
export function toggleSessionPin(sessionId: string): void {
	useUiPreferencesStore.getState().togglePin(sessionId);
}

/** 会话 cwd：后端离线改名靠它精确查会话文件（未加载会话只在目录投影 `allSessions` 里）。 */
function sessionCwd(sessionId: string): string | undefined {
	return (
		useSessionsStore.getState().sessions.find((s) => s.sessionId === sessionId)?.cwd ??
		useProjectsStore.getState().allSessions.find((s) => s.sessionId === sessionId)?.cwd
	);
}

/** 重命名落盘：活跃会话靠 session_info_changed 事件回流，历史会话无事件 → 本地立即更新（幂等）。
 *  两份拷贝都要同步：`sessions`（内存会话/胶囊详情）与 `projects.allSessions`（左栏会话行与未加载胶囊的 meta），
 *  只更新一边会出现「胶囊新名 / 左栏旧名」并存（阶段 3 实测踩到）。 */
export function renameSession(sessionId: string, name: string): void {
	if (!name) return; // 空值 = 保持原名（与系统重命名一致，不报错）
	getPi()
		.setSessionName({ sessionId, name, cwd: sessionCwd(sessionId) })
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
