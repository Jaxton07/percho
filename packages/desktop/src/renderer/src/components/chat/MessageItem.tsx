import { memo, useState } from "react";
import { useT } from "../../i18n";
import { Slot } from "../../plugins/Slot";
import { UI_SLOTS } from "../../plugins/slots";
import type { UIMessage } from "../../stores/transcript";
import { AssistantMessage } from "./AssistantMessage";
import { ErrorNote } from "./ErrorNote";
import { ImagePreviewOverlay, imageSrc } from "./ImagePreview";
import { CopyButton, ForkButton } from "./message-actions";
import { SubagentRunCard } from "./SubagentRunCard";
import { SystemMessage } from "./SystemMessage";
import { UserMessage } from "./UserMessage";

/** 单条消息：按类型分发（用户气泡 / 图片块 / 子代理卡 / 错误卡 / 系统分割线 / 助手消息体） */
export const MessageItem = memo(function MessageItem({
	message,
	streaming,
	metaInGroup,
	showActions = true,
	sessionId = null,
}: {
	message: UIMessage;
	streaming?: boolean;
	/** 思考/工具已并入上方合并组，不再自行包裹（正文消息由 MessageList 调用） */
	metaInGroup?: boolean;
	/** 是否渲染操作行：仅轮次最后一段正文为 true（中间自言自语不挂复制/fork，减少噪音） */
	showActions?: boolean;
	/** 当前会话（错误卡重试/压缩动作需要） */
	sessionId?: string | null;
}) {
	const t = useT();
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);

	if (message.kind === "user") {
		return <UserMessage message={message} />;
	}

	if (message.kind === "image") {
		// show_image 发图：assistant 侧独立图片块，点击全屏预览。
		// 单图自然比例；多图统一正方形缩略图按数量分档（一行优先，超出 flex-wrap 换行）
		const count = message.images.length;
		const sizeClass =
			count === 1
				? "max-h-36 max-w-48 object-contain"
				: count <= 3
					? "h-24 w-24 object-cover"
					: count <= 6
						? "h-20 w-20 object-cover"
						: "h-16 w-16 object-cover";
		return (
			<div>
				<div className="flex flex-wrap gap-2">
					{message.images.map((image, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: 图片列表不可变
							key={index}
							type="button"
							className="overflow-hidden rounded-xl border border-border"
							onClick={() => setPreviewIndex(index)}
						>
							<img src={imageSrc(image)} alt={t("message.image")} className={sizeClass} />
						</button>
					))}
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

	if (message.kind === "subagent") {
		return <Slot name={UI_SLOTS.SubagentCard} props={{ runs: message.runs }} fallback={SubagentRunCard} />;
	}

	if (message.kind === "error") {
		// 统一报错卡（v2 无边框悬浮卡片；旧大红底纯文本分支已被替换）
		return <ErrorNote sessionId={sessionId} cardId={message.id} error={message.error} />;
	}

	if (message.kind === "system") {
		return <SystemMessage message={message} />;
	}

	return (
		<div className="group">
			<AssistantMessage
				text={message.text}
				thinking={message.thinking}
				tools={message.tools}
				streaming={streaming}
				metaInGroup={metaInGroup}
			/>
			{/* 操作行（仅轮次最后一段正文）：复制正文 + 从此处分叉；agent 回复结束后出现 */}
			{!streaming && message.text && showActions && (
				<div className="mt-0.5 flex items-center gap-1">
					<CopyButton text={message.text} />
					<ForkButton entryId={message.entryId} matchText={message.sourceText ?? message.text} />
				</div>
			)}
		</div>
	);
});
