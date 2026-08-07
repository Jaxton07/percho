import type { ImageInput } from "@pi-desktop/shared";
import { memo, useState } from "react";
import { useT } from "../../i18n";
import type { UIMessage } from "../../stores/transcript";
import { AssistantMessage } from "./AssistantMessage";

function imageSrc(image: ImageInput): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/** 单条消息：按类型分发（用户气泡 / 错误 / 助手消息体） */
export const MessageItem = memo(function MessageItem({
	message,
	streaming,
}: {
	message: UIMessage;
	streaming?: boolean;
}) {
	const t = useT();
	const [previewImage, setPreviewImage] = useState<ImageInput | null>(null);

	if (message.kind === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[85%]">
					{message.images.length > 0 && (
						<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
							{message.images.map((image, index) => (
								<button
									key={index}
									type="button"
									className="h-16 w-16 overflow-hidden rounded-lg border border-zinc-200"
									title={t("composer.previewImage")}
									onClick={() => setPreviewImage(image)}
								>
									<img
										src={imageSrc(image)}
										alt={`${t("composer.previewImage")} ${index + 1}`}
										className="h-full w-full object-cover"
									/>
								</button>
							))}
						</div>
					)}
					{message.text && (
						<div className="rounded-2xl rounded-br-md bg-zinc-900 px-3.5 py-2 text-[14px] leading-relaxed text-white select-text">
							{message.text}
						</div>
					)}
				</div>
				{previewImage && (
					<button
						type="button"
						className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
						onClick={() => setPreviewImage(null)}
						title={t("common.close")}
					>
						<img
							src={imageSrc(previewImage)}
							alt={t("composer.previewImage")}
							className="max-h-full max-w-full rounded-lg object-contain"
						/>
					</button>
				)}
			</div>
		);
	}

	if (message.kind === "error") {
		return (
			<div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-600 select-text">
				{message.text}
			</div>
		);
	}

	return (
		<AssistantMessage
			text={message.text}
			thinking={message.thinking}
			tools={message.tools}
			streaming={streaming}
		/>
	);
});
