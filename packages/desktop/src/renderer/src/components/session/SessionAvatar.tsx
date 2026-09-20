import type { SessionMeta } from "@percho/shared";
import { isDailyCwd } from "../../lib/daily";
import { CoffeeIcon, SubagentIcon } from "../icons";
import { type SessionStatus, sessionAvatarClass, sessionLetter } from "./session-status";

/**
 * 会话头像（顶栏胶囊 / 左侧轨道 / 悬浮会话列表三处共用一份渲染）：
 * 状态语义全收进这 16/18px 方块——字形 = 空间归属（只读子代理图标 / 日常咖啡 / 项目目录首字母），
 * 底色 = 运行状态（审批琥珀 / 工作中墨色呼吸 / 完成未读绿点 / 当前会话墨色），色板在 session-status.ts。
 * 只订阅调用方已算好的 status，本组件不自己订状态（顶栏 ghost 与轨道展开胶囊都要复用）。
 */
export function SessionAvatar({
	session,
	status,
	isActive,
	size = 16,
	/** 完成绿点的描边色：跟随所在浮层的底色（画布上的胶囊用 canvas，面板 veil 上用 surface） */
	dotRing = "ring-surface",
}: {
	session: SessionMeta;
	status: SessionStatus;
	isActive: boolean;
	/** 尺寸：16 = 顶栏胶囊/轨道，18 = 悬浮列表 */
	size?: 16 | 18;
	dotRing?: "ring-canvas" | "ring-surface";
}) {
	const daily = isDailyCwd(session.cwd);
	const box = size === 18 ? "h-[18px] w-[18px] rounded-[5px] text-[10.5px]" : "h-4 w-4 rounded text-[10px]";
	return (
		<span
			className={`relative flex shrink-0 items-center justify-center font-semibold ${box} ${sessionAvatarClass(
				status,
				{ isActive, daily, readOnly: session.readOnly },
			)}`}
		>
			{session.readOnly ? (
				<SubagentIcon size={11} />
			) : daily ? (
				<CoffeeIcon size={10} />
			) : (
				sessionLetter(session).toUpperCase()
			)}
			{!session.readOnly && status === "done" && (
				<span
					className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-green-500 ring-1 ${dotRing}`}
				/>
			)}
		</span>
	);
}
