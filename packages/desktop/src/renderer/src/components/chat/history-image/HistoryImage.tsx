import type { ImageInput } from "@percho/shared";
import { type Ref, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../../../i18n";
import { createHistoryImageBinding, type HistoryImageBinding, INERT_SNAPSHOT } from "./history-image-binding";
import { historyImageObserver } from "./history-image-observer";
import { useHistoryImageRoot } from "./history-image-root";
import { type ThumbnailService, type ThumbnailSnapshot, thumbnailService } from "./history-image-service";

/**
 * 历史列表里的一张图（用户附件与 show_image 两个入口共用）。
 *
 * 分工（阶段 1/2 的结论都收在这一层）：
 * - **几何**：外盒尺寸由调用方给（`history-image-layout` 的档位），占位/就绪/失败三态同尺寸，
 *   行高不随加载变化；`img` 只负责在盒内铺满，列表里**永远只出现 ≤384px 的缩略图 blob: URL**，
 *   没有原图回退；
 * - **加载**：交给 `history-image-service`（48 slots / 队列 / LRU / 单飞 / 超时重置），
 *   可见性由共享 IntersectionObserver 按「真实落在滚动容器可视区内」给出；
 * - **预览**：点击外盒仍然是打开原图预览（占位态也能点），失败态点击是重试。
 *
 * 拿不到 root（没接线）时只渲染同尺寸占位，**不做任何加载**。
 */
export interface HistoryImageProps {
	image: ImageInput;
	/** 外盒（固定尺寸）与盒内 img 的 class，来自 history-image-layout */
	boxClass: string;
	imgClass: string;
	/** 调用方的表现层 class（圆角/描边等）：与几何分开，便于视觉调整不动尺寸 */
	extraClass?: string;
	alt: string;
	onOpen: () => void;
	/** 只为单测注入；生产用进程内单例 */
	service?: ThumbnailService;
}

export function HistoryImage({
	image,
	boxClass,
	imgClass,
	extraClass = "",
	alt,
	onOpen,
	service,
}: HistoryImageProps) {
	const root = useHistoryImageRoot();
	const targetRef = useRef<HTMLSpanElement | null>(null);
	const [binding, setBinding] = useState<HistoryImageBinding | null>(null);
	const [generation, setGeneration] = useState(0);
	const resolvedService = service ?? thumbnailService();

	// 服务换代（切会话 reset）会让既有句柄失效：订阅它并重建接线，否则会永远停在占位
	useEffect(() => {
		return resolvedService.subscribeReset(() => {
			setGeneration((value) => value + 1);
		});
	}, [resolvedService]);

	// 建立/销毁接线（**不在 render 里 acquire**；依赖变化时先释放旧的再建新的）
	useEffect(() => {
		if (!root || !targetRef.current) {
			setBinding(null);
			return;
		}
		const created = createHistoryImageBinding({
			service: resolvedService,
			image,
			element: targetRef.current,
			observer: historyImageObserver(root),
		});
		setBinding(created);
		return () => {
			created.dispose();
		};
	}, [resolvedService, image, root, generation]);

	const subscribe = useCallback(
		(listener: () => void) => (binding ? binding.subscribe(listener) : () => {}),
		[binding],
	);
	const getSnapshot = useCallback(() => (binding ? binding.getSnapshot() : INERT_SNAPSHOT), [binding]);
	const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => INERT_SNAPSHOT);
	const retry = useCallback(() => {
		binding?.retry();
	}, [binding]);

	return (
		<HistoryImageSurface
			elementRef={targetRef}
			rootConnected={root !== null}
			bindingReady={binding !== null}
			snapshot={snapshot}
			boxClass={boxClass}
			imgClass={imgClass}
			extraClass={extraClass}
			alt={alt}
			onOpen={onOpen}
			onRetry={retry}
		/>
	);
}

/** 纯展示层（无 hook / 无服务）：外盒 + 三态占位，SSR 可测 */
export function HistoryImageSurface({
	elementRef,
	rootConnected,
	bindingReady,
	snapshot,
	boxClass,
	imgClass,
	extraClass = "",
	alt,
	onOpen,
	onRetry,
}: {
	/** 观察目标（外盒元素）：由接线层传入，SSR 里为 undefined */
	elementRef?: Ref<HTMLSpanElement | null>;
	/** 是否已接入私有 root（未接入 = 只渲染占位，不加载）：给验收脚本一个可观测点 */
	rootConnected?: boolean;
	/** 接线对象是否已建立（effect 跑过）：同样只为验收可观测 */
	bindingReady?: boolean;
	snapshot: ThumbnailSnapshot;
	boxClass: string;
	imgClass: string;
	extraClass?: string;
	alt: string;
	onOpen: () => void;
	onRetry: () => void;
}) {
	const t = useT();
	const waiting = snapshot.status !== "ready" && snapshot.status !== "error";
	const label =
		snapshot.status === "error"
			? `${t("message.imageLoadError")}，${t("message.imageRetry")}`
			: snapshot.status === "ready"
				? alt
				: `${alt}，${t("message.imagePending")}`;
	return (
		// 外盒：尺寸只来自 boxClass（加载前/后、失败态都同尺寸）；点击交给内部 overlay button
		<span
			ref={elementRef}
			data-history-image={snapshot.status}
			data-history-image-root={rootConnected === false ? "detached" : "connected"}
			data-history-image-binding={bindingReady ? "attached" : "none"}
			className={`${boxClass} ${extraClass} relative block overflow-hidden bg-hover`}
		>
			{snapshot.status === "ready" && snapshot.url ? (
				<img
					src={snapshot.url}
					alt={alt}
					className={imgClass}
					/* 真缩略图同样 lazy/async（spec P2）：滚出去的缩略图不必占着解码 */
					loading="lazy"
					decoding="async"
					data-history-image-src="blob"
				/>
			) : (
				<span className="absolute inset-0 flex items-center justify-center">
					{waiting ? (
						<svg
							viewBox="0 0 16 16"
							width="16"
							height="16"
							aria-hidden="true"
							className="text-ink-faint opacity-40"
						>
							<rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" />
							<circle cx="5.5" cy="6.5" r="1" fill="currentColor" />
							<path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" fill="none" stroke="currentColor" />
						</svg>
					) : (
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="text-err">
							<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" />
							<path d="M8 4.5v4.5" stroke="currentColor" />
							<circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
						</svg>
					)}
				</span>
			)}
			<button
				type="button"
				className="absolute inset-0 cursor-pointer"
				aria-label={label}
				onClick={snapshot.status === "error" ? onRetry : onOpen}
			/>
		</span>
	);
}
