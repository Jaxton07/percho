import type { ImageInput } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";

export function imageSrc(image: ImageInput): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * 全屏图片预览遮罩：点击任意处关闭（用户消息图片与 show_image 图片消息共用）。
 * 多图支持 ←/→ 切换、Esc 关闭，右上角显示 n / total。
 * Portal 到 body：预览若挂在滚动容器（relative z-10，自成 stacking context）内，
 * fixed z-50 逃不出该 context，「回到底部」按钮（同级 z-10、DOM 靠后）会盖住预览图；
 * body 层 z-50 位于根 stacking context，遮罩永远全局顶层。
 */
export function ImagePreviewOverlay({
	image,
	images,
	initialIndex = 0,
	onClose,
}: {
	/** 单图调用（Composer / UI 插件）用 image；多图传 images */
	image?: ImageInput;
	images?: ImageInput[];
	initialIndex?: number;
	onClose: () => void;
}) {
	const t = useT();
	const list = images ?? (image ? [image] : []);
	const count = list.length;
	const [index, setIndex] = useState(() => Math.min(initialIndex, count - 1));
	// onClose 多为内联箭头（每次渲染新引用）：存 ref，keydown 监听不随父组件重渲染重挂
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			// 焦点可能仍在 Composer 输入框：拦下默认行为，避免 ←/→ 同时移动输入光标
			if (e.key === "Escape") {
				e.preventDefault();
				onCloseRef.current();
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				setIndex((i) => Math.max(0, i - 1));
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				setIndex((i) => Math.min(count - 1, i + 1));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [count]);

	if (count === 0) return null;
	const current = list[index];
	if (!current) return null;

	return createPortal(
		<button
			type="button"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
			onClick={onClose}
		>
			<img
				src={imageSrc(current)}
				alt={t("message.image")}
				className="max-h-full max-w-full rounded-lg object-contain"
			/>
			{count > 1 && (
				<span className="absolute top-4 right-5 rounded-full bg-black/50 px-2.5 py-1 text-[11px] text-white/80 select-none">
					{index + 1} / {count}
				</span>
			)}
		</button>,
		document.body,
	);
}
