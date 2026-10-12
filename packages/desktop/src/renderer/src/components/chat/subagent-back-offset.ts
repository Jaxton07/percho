/**
 * 「返回父会话」入口的水平偏移（spec D4 收尾调整）：把入口摆到**聊天区左缘与对话区之间的空带正中**。
 *
 * 为什么不写成 CSS：入口所在的角容器是 `absolute left-4` + **shrink-to-fit**，容器宽度 = 内容宽度，
 * 写在里面的 `%` 是相对「一枚图标的宽度」而不是聊天区，算不出这条带子；角容器自身也不能改（同角还堆着
 * 插件贡献，改容器会连带把它们一起挪走）。所以偏移量在运行时算好，只写成入口自己的 transform。
 *
 * 坐标可以是任意同一坐标系（只用相对差值，视口坐标即可）；全部用**未偏移**的值：
 * - `mainLeft`：聊天区（`main`）左缘
 * - `naturalLeft`：入口未偏移时的左缘（取 `offsetParent` + `offsetLeft`，不受 transform 影响）
 * - `columnLeft` / `columnPaddingLeft`：对话区列盒左缘 + 该列自身内边距 ⇒ 可见内容左缘
 * - `buttonWidth`：入口宽度（未偏移的 `offsetWidth`，用于把**中心**对到带子中点）
 *
 * 返回 `translateX` 的像素值，**恒 ≥ 0**：带子不够宽时归 0 —— 即保持「贴左缘 16px」的基线位置，
 * 退化情形（聊天区窄到列已占满）与调整前完全一致。
 */
export function backButtonOffset(input: {
	mainLeft: number;
	naturalLeft: number;
	columnLeft: number;
	columnPaddingLeft: number;
	buttonWidth: number;
}): number {
	const { mainLeft, naturalLeft, columnLeft, columnPaddingLeft, buttonWidth } = input;
	const contentLeft = columnLeft + columnPaddingLeft; // 可见内容（气泡）左缘 —— 视觉上的「对话区」
	const bandCenter = (contentLeft - mainLeft) / 2; // 空带中点，相对聊天区左缘
	const target = mainLeft + bandCenter - buttonWidth / 2; // 让入口**中心**落在带子中点
	return Math.max(0, Math.round(target - naturalLeft));
}
