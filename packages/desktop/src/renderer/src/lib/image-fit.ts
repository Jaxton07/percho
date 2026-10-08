/**
 * 附件图片规格（纯函数）：把用户附件预缩放到模型能吃下的规格，**与 SDK 侧 AutoResize 对齐**。
 *
 * 为什么要自己算一遍：SDK 在构造用户消息前对附件做归一化（Photon WASM 在 worker 里缩放 + 重编码），
 * 全屏 Retina 截图要 0.8–1.1s/张，而且这段时间用户气泡只能空着等。若我们**在粘贴/选择图片时**
 * 就把它缩好，SDK 的 `processImage` 会走「已在限内」快路径（实测 ~20-40ms）。
 *
 * 阈值镜像 SDK 默认值 `pi-coding-agent/dist/utils/image-resize-core.js` 的 `DEFAULT_OPTIONS`
 * （模型目录里 1125 条 `inputLimits.images.resize` 全是同一组：2000×2000 / 4.5MB base64 / jpeg q80）。
 * 万一将来 SDK 改了而这里没跟上，最坏结果只是 SDK 再缩一次（退回今天的行为），不会坏。
 */

/** 最长边上限（px） */
export const IMAGE_MAX_DIMENSION = 2000;
/** 编码后 base64 字符串长度上限（4.5MB，SDK 同值） */
export const IMAGE_MAX_BASE64_BYTES = 4_718_592;
/** 超体积时依次尝试的 JPEG 质量（首轮 PNG/q80 已试，这里从 q70 往下） */
export const IMAGE_JPEG_QUALITIES = [70, 60, 50];
/** 降质仍超限时每轮缩身比例 */
export const IMAGE_SHRINK_STEP = 0.85;
/** 缩身轮数上限（0.85^8 ≈ 0.27，足够把 4.5MB 压到限内） */
export const IMAGE_SHRINK_ROUNDS = 8;

/** base64 编码后的字节数（不实际编码，纯算，用于提前判断） */
export function base64Size(bytes: number): number {
	return Math.ceil(bytes / 3) * 4;
}

/** 尺寸与体积都在限内 → 原样送（不重编码，保住原图质量也省一次编码） */
export function withinImageLimits(input: { width: number; height: number; bytes: number }): boolean {
	return (
		input.width <= IMAGE_MAX_DIMENSION &&
		input.height <= IMAGE_MAX_DIMENSION &&
		base64Size(input.bytes) < IMAGE_MAX_BASE64_BYTES
	);
}

/** 等比缩到最长边 ≤ max（只缩不放；已是合法尺寸原样返回） */
export function fitDimensions(
	width: number,
	height: number,
	max = IMAGE_MAX_DIMENSION,
): { width: number; height: number } {
	if (width <= max && height <= max) return { width, height };
	const scale = max / Math.max(width, height);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/** 再缩一轮（体积仍超限时用；不小于 1px） */
export function shrinkDimensions(
	width: number,
	height: number,
	step = IMAGE_SHRINK_STEP,
): { width: number; height: number } {
	return {
		width: Math.max(1, Math.round(width * step)),
		height: Math.max(1, Math.round(height * step)),
	};
}

/** 候选编码：在限内的取体积最小的那个（镜像 SDK「PNG/JPEG 取更小」的选择）；都不在限内返回 null */
export function pickSmallestWithinLimit<T extends { bytes: number }>(candidates: readonly T[]): T | null {
	let best: T | null = null;
	for (const candidate of candidates) {
		if (base64Size(candidate.bytes) >= IMAGE_MAX_BASE64_BYTES) continue;
		if (!best || candidate.bytes < best.bytes) best = candidate;
	}
	return best;
}
