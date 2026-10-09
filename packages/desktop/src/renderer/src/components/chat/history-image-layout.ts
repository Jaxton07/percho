/**
 * 历史图片的尺寸模式：**几何稳定的唯一来源**（叶模块，不 import React / store / i18n）。
 *
 * 为什么不把尺寸写死在组件里：列表图片的高度若取决于「图片解码出来的固有尺寸」，
 * 那么加载前/后、失败前后行高都会变，长会话上滚时会被滚动锚定补偿牵着走（见 docs/PITFALLS.md
 * 「长会话切会话卡顿」）。所以外盒尺寸一律由这里**预先定死**，img 只负责在盒内填充。
 *
 * 尺寸档位来自 spec（多图分档沿用改造前的视觉档位，单图改为稳定外盒 192×144）：
 * - 用户附件缩略图：64×64（object-cover，裁切）
 * - show_image 单图：192×144 稳定外盒（object-contain，允许留白换高度稳定）
 * - show_image 2–3 张：96×96；4–6 张：80×80；7–9 张：64×64（均为 object-cover）
 */

export interface HistoryImageMode {
	/** 外盒（挂 class 在 button/包裹层上）：固定尺寸，不随图片加载变化 */
	box: string;
	/** 盒内 img：铺满外盒 */
	img: string;
}

/** 单图稳定外盒像素尺寸（Tailwind h-36 / w-48） */
export const SINGLE_IMAGE_BOX = { width: 192, height: 144 } as const;

/** 用户附件缩略图：固定 64 方格 */
export const ATTACHMENT_IMAGE_MODE: HistoryImageMode = {
	box: "h-16 w-16",
	img: "h-full w-full object-cover",
};

const SINGLE_IMAGE_MODE: HistoryImageMode = {
	// max-w-full：窄窗下外盒不撑破容器（高度保持 144 不变，几何仍稳定）
	box: "h-36 w-48 max-w-full",
	img: "h-full w-full object-contain",
};

const MULTI_THREE_MODE: HistoryImageMode = {
	box: "h-24 w-24",
	img: "h-full w-full object-cover",
};

const MULTI_SIX_MODE: HistoryImageMode = {
	box: "h-20 w-20",
	img: "h-full w-full object-cover",
};

const MULTI_NINE_MODE: HistoryImageMode = {
	box: "h-16 w-16",
	img: "h-full w-full object-cover",
};

/** show_image 单条消息按图片数量取档位（1 / 2–3 / 4–6 / 7–9） */
export function modeForImageCount(count: number): HistoryImageMode {
	if (count <= 1) return SINGLE_IMAGE_MODE;
	if (count <= 3) return MULTI_THREE_MODE;
	if (count <= 6) return MULTI_SIX_MODE;
	return MULTI_NINE_MODE;
}
