import type { ImageInput } from "@percho/shared";
import { useT } from "../../i18n";
import { imageSrc } from "../chat/ImagePreview";
import { CloseIcon } from "../icons";

/**
 * 待发送图片缩略图条：点击放大预览，× 删除。
 * 悬浮层（absolute bottom-full 锚在 composer 内容列顶、浮于对话区之上），不占文档流——
 * 粘贴图片不再撑高输入框压缩 main 对话区（曾把用户正在读的消息齐边切掉，像被背景盖住）。
 * 无包裹卡片：容器透明只做排布，每张缩略图自带 shadow-pop 单独悬浮；多图向上生长（bottom 定位）。
 */
export function ImageTray({
	images,
	onPreview,
	onRemove,
}: {
	images: ImageInput[];
	onPreview: (image: ImageInput) => void;
	onRemove: (index: number) => void;
}) {
	const t = useT();
	if (images.length === 0) return null;
	return (
		<div className="absolute bottom-full left-0 z-10 mb-2 flex max-w-full flex-wrap items-end gap-2">
			{images.map((image, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: 缩略图列表不可变（删除为整列表替换）
					key={index}
					className="group relative"
				>
					<button
						type="button"
						className="block h-16 w-16 overflow-hidden rounded-lg border border-border bg-surface shadow-pop"
						onClick={() => onPreview(image)}
					>
						<img
							src={imageSrc(image)}
							alt={`${t("composer.previewImage")} ${index + 1}`}
							className="h-full w-full object-cover"
						/>
					</button>
					<button
						type="button"
						className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-ink text-on-ink shadow transition-colors hover:bg-red-600"
						aria-label={t("composer.removeImage")}
						onClick={() => onRemove(index)}
					>
						<CloseIcon size={8} />
					</button>
				</div>
			))}
		</div>
	);
}
