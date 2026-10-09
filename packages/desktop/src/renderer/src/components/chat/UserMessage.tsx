import { formatSkillCommand } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../i18n";
import type { UIMessage } from "../../stores/transcript";
import { ATTACHMENT_IMAGE_MODE } from "./history-image-layout";
import { ImagePreviewOverlay, imageSrc } from "./ImagePreview";
import { CopyButton, RecallButton } from "./message-actions";

/** 用户消息气泡：缩略图 + skill 调用气泡 + 文本气泡 + 操作行（复制/撤回）+ 全屏预览 */
export function UserMessage({ message }: { message: Extract<UIMessage, { kind: "user" }> }) {
	const t = useT();
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);

	return (
		<div className="group flex justify-end">
			<div className="max-w-[85%]">
				{message.images.length > 0 && (
					<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
						{message.images.map((image, index) => (
							<button
								// biome-ignore lint/suspicious/noArrayIndexKey: 缩略图列表不可变（删除为整列表替换）
								key={index}
								type="button"
								className={`${ATTACHMENT_IMAGE_MODE.box} overflow-hidden rounded-lg border border-border`}
								onClick={() => setPreviewIndex(index)}
							>
								<img
									src={imageSrc(image)}
									alt={`${t("composer.previewImage")} ${index + 1}`}
									className={ATTACHMENT_IMAGE_MODE.img}
									/* 历史图片：滚动近处才加载、解码让出主线程；尺寸由外盒固定，加载不改变行高 */
									loading="lazy"
									decoding="async"
								/>
							</button>
						))}
					</div>
				)}
				{message.skill ? (
					<div className="rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-ui-15 leading-[1.7] text-ink select-text">
						<div
							className={
								message.text ? "mb-1 font-mono text-ui-12 text-ink-dim" : "font-mono text-ui-12 text-ink-dim"
							}
						>
							{t("message.skillInvocation", { name: message.skill.name })}
						</div>
						{message.text && <div className="whitespace-pre-wrap break-words">{message.text}</div>}
					</div>
				) : (
					message.text && (
						<div className="rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-ui-15 leading-[1.7] whitespace-pre-wrap break-words text-ink select-text">
							{message.text}
						</div>
					)
				)}
				{(message.skill || message.text || message.images.length > 0) && (
					<div className="mt-1 flex items-center justify-end gap-1">
						{(message.skill || message.text) && (
							<CopyButton text={message.skill ? formatSkillCommand(message.skill) : message.text} />
						)}
						{/* pending（乐观回显、权威消息未到）时不给「撤回」：后端还没这条消息，点了只会报错 */}
						{!message.pending && (
							<RecallButton
								entryId={message.entryId}
								matchText={message.sourceText ?? message.text}
								timestamp={message.timestamp}
							/>
						)}
					</div>
				)}
			</div>
			{previewIndex !== null && (
				<ImagePreviewOverlay
					images={message.images}
					initialIndex={previewIndex}
					onClose={() => setPreviewIndex(null)}
				/>
			)}
		</div>
	);
}
