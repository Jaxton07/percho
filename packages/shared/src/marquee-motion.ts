/** 无 DOM 的流式正文 tail-follow 位置计算。 */

/**
 * 将动态文本的右缘贴到视口右缘，令最新 token 始终可见。
 * 无效尺寸或未溢出时停在开头。
 */
export function tailOffsetForWidths(textWidth: number, viewportWidth: number): number {
	if (!Number.isFinite(textWidth) || !Number.isFinite(viewportWidth)) return 0;
	return Math.max(0, textWidth - viewportWidth);
}
