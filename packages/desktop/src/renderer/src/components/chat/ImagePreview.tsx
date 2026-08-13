import type { ImageInput } from "@percho/shared";
import { useT } from "../../i18n";

export function imageSrc(image: ImageInput): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/** 全屏图片预览遮罩：点击任意处关闭（用户消息图片与 show_image 图片消息共用） */
export function ImagePreviewOverlay({ image, onClose }: { image: ImageInput; onClose: () => void }) {
	const t = useT();
	return (
		<button
			type="button"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
			onClick={onClose}
		>
			<img
				src={imageSrc(image)}
				alt={t("message.image")}
				className="max-h-full max-w-full rounded-lg object-contain"
			/>
		</button>
	);
}
