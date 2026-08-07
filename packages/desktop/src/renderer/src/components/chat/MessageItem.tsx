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
	metaInGroup,
}: {
	message: UIMessage;
	streaming?: boolean;
	/** 思考/工具已并入上方合并组，不再自行包裹（正文消息由 MessageList 调用） */
	metaInGroup?: boolean;
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
									// biome-ignore lint/suspicious/noArrayIndexKey: 缩略图列表不可变（删除为整列表替换）
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
						<div className="rounded-2xl rounded-br-md bg-zinc-200 px-3.5 py-2 text-[14px] leading-relaxed text-zinc-800 select-text">
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

	if (message.kind === "system") {
		return <SystemMessage message={message} />;
	}

	return (
		<AssistantMessage
			text={message.text}
			thinking={message.thinking}
			tools={message.tools}
			streaming={streaming}
			metaInGroup={metaInGroup}
		/>
	);
});

function SystemMessage({ message }: { message: Extract<UIMessage, { kind: "system" }> }) {
	const t = useT();
	const compact = message.compact;
	if (!compact) return null;
	const reason = t(`compaction.reason.${compact.reason}`);
	if (compact.status === "running") {
		return (
			<div className="flex items-center justify-center gap-2 py-1 text-xs text-zinc-400">
				<span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-500" />
				<span>
					{t("compaction.running")} · {reason}
				</span>
			</div>
		);
	}
	const tokens =
		compact.tokensBefore != null && compact.tokensAfter != null
			? ` · ${formatTokens(compact.tokensBefore)} → ${formatTokens(compact.tokensAfter)}`
			: "";
	if (compact.status === "cancelled") {
		return (
			<div className="py-1 text-center text-xs text-zinc-400">
				{t("compaction.cancelled")} · {reason}
			</div>
		);
	}
	if (compact.status === "error") {
		return (
			<div className="py-1 text-center text-xs text-red-500">
				{t("compaction.failed", { error: compact.errorMessage ?? "" })}
			</div>
		);
	}
	return (
		<div
			className="mx-auto max-w-[560px] rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-center text-xs leading-relaxed text-zinc-500 select-text"
			title={compact.summary}
		>
			<p className="font-medium text-zinc-600">
				{t("compaction.done")} · {reason}
				{tokens}
			</p>
			{compact.summary && <p className="mt-1 line-clamp-3">{compact.summary}</p>}
		</div>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
