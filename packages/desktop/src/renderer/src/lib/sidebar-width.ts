import { CHAT_MIN_WIDTH, clampSidebarWidth, SIDEBAR_MIN_WIDTH } from "@percho/shared";

/**
 * 侧栏**渲染宽**（纯函数，有单测）：用户意图值再被「容器宽 - 聊天列最小宽」二次夹紧。
 *
 * 为什么必须夹、且内外层必须吃**同一个值**（REVIEW R1）：
 * 外层 `.sidebar` 夹紧了内层却没夹，窄窗下 `.sidebar-inner`（480）会比外层（320）宽，
 * `overflow: hidden` 会把内层右侧 160px **硬裁**掉 —— 被裁的正是「项目操作 ⋯ / 添加项目 /
 * 在项目中新建会话」这些功能控件，用户点不到也看不见。触发区间不极端：侧栏 W 时窗口 < W + 聊天列最小宽即触发。
 *
 * 容器宽未知（首帧 ResizeObserver 还没上报、或组件尚未挂载）时退回用户值：宁可先宽一帧，
 * 也不要因为「0 宽」把侧栏挤成 200。
 */
export function sidebarRenderWidth(userWidth: number, containerWidth: number): number {
	const user = clampSidebarWidth(userWidth);
	if (!Number.isFinite(containerWidth) || containerWidth <= 0) return user;
	return Math.max(SIDEBAR_MIN_WIDTH, Math.min(user, containerWidth - CHAT_MIN_WIDTH));
}
