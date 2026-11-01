import { type DisplayImage, type ImageInput, isReferenceImage } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { subscribeImageInvalidation } from "./history-image/image-invalidation";
import { imageReader } from "./history-image/image-reader";

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
	resolveImage = imageReader.read,
}: {
	/** 单图调用（Composer / UI 插件）用 image；多图传 images */
	image?: DisplayImage;
	images?: DisplayImage[];
	resolveImage?: (image: DisplayImage, signal?: AbortSignal) => Promise<ImageInput>;
	initialIndex?: number;
	onClose: () => void;
}) {
	const t = useT();
	const list = images ?? (image ? [image] : []);
	const count = list.length;
	const [index, setIndex] = useState(() => Math.min(initialIndex, count - 1));
	// onClose 多为内联箭头（每次渲染新引用）：存 ref，keydown 监听不随父组件重渲染重挂
	const current = list[index];
	const [resolved, setResolved] = useState<{ image: DisplayImage; src: string } | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!current || !isReferenceImage(current)) return;
		let disposed = false;
		const controller = new AbortController();
		let url: string | null = null;
		setFailed(false);
		if (!resolveImage) {
			setFailed(true);
			return;
		}
		const unsubscribe = subscribeImageInvalidation(current, () => {
			disposed = true;
			controller.abort();
			if (url) {
				URL.revokeObjectURL(url);
				url = null;
			}
			setResolved(null);
			setFailed(true);
		});
		void Promise.resolve()
			.then(() => {
				if (disposed) throw new Error("Image preview source was invalidated");
				return resolveImage(current, controller.signal);
			})
			.then((image) => {
				if (disposed) return;
				const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
				url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
				setResolved({ image: current, src: url });
			})
			.catch(() => {
				if (!disposed) setFailed(true);
			});
		return () => {
			disposed = true;
			unsubscribe();
			controller.abort();
			if (url) URL.revokeObjectURL(url);
		};
	}, [current, resolveImage]);
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
	if (!current) return null;
	const src = isReferenceImage(current)
		? resolved?.image === current
			? resolved.src
			: null
		: imageSrc(current);

	return createPortal(
		<button
			type="button"
			data-image-preview="open"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
			onClick={onClose}
		>
			{src ? (
				<img
					src={src}
					alt={t("message.image")}
					className="max-h-full max-w-full rounded-lg object-contain"
					decoding="async"
				/>
			) : (
				<span className="text-ui-13 text-white/80">
					{t(failed ? "message.imageLoadError" : "message.imagePending")}
				</span>
			)}
			{count > 1 && (
				<span className="absolute top-4 right-5 rounded-full bg-black/50 px-2.5 py-1 text-ui-11 text-white/80 select-none">
					{index + 1} / {count}
				</span>
			)}
		</button>,
		document.body,
	);
}
