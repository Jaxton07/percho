import type { ImageInput } from "@pi-desktop/shared";
import { memo, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { UIMessage } from "../../stores/transcript";
import { AssistantMessage } from "./AssistantMessage";

function imageSrc(image: ImageInput): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/** 用户消息复制按钮：hover 气泡显示（常驻占位避免布局抖动），复制成功短暂变为对勾 */
function CopyButton({ text }: { text: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const timerRef = useRef(0);

	useEffect(() => () => window.clearTimeout(timerRef.current), []);

	const handleCopy = () => {
		navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopied(true);
				window.clearTimeout(timerRef.current);
				timerRef.current = window.setTimeout(() => setCopied(false), 1200);
			})
			.catch(() => {});
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			title={copied ? t("message.copied") : t("message.copy")}
			aria-label={copied ? t("message.copied") : t("message.copy")}
			className="flex h-6 w-6 items-center justify-center rounded-md text-ink-faint opacity-0 transition-opacity duration-150 hover:bg-border/70 hover:text-ink-2 focus-visible:opacity-100 group-hover:opacity-100"
		>
			{copied ? (
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="text-green-500"
					aria-hidden="true"
				>
					<path d="M20 6 9 17l-5-5" />
				</svg>
			) : (
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<rect x="9" y="9" width="13" height="13" rx="2" />
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
				</svg>
			)}
		</button>
	);
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
			<div className="group flex justify-end">
				<div className="max-w-[85%]">
					{message.images.length > 0 && (
						<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
							{message.images.map((image, index) => (
								<button
									// biome-ignore lint/suspicious/noArrayIndexKey: 缩略图列表不可变（删除为整列表替换）
									key={index}
									type="button"
									className="h-16 w-16 overflow-hidden rounded-lg border border-border"
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
						<div className="rounded-2xl rounded-br-md bg-border px-3.5 py-2 text-[14px] leading-relaxed text-ink select-text">
							{message.text}
						</div>
					)}
					{message.text && (
						<div className="mt-1 flex justify-end">
							<CopyButton text={message.text} />
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
			<div className="flex items-center justify-center gap-2 py-1 text-xs text-ink-faint">
				<span className="h-3 w-3 animate-spin rounded-full border-2 border-border-strong border-t-ink-dim" />
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
			<div className="py-1 text-center text-xs text-ink-faint">
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
			className="mx-auto max-w-[560px] rounded-lg border border-border bg-hover px-3 py-2 text-center text-xs leading-relaxed text-ink-dim select-text"
			title={compact.summary}
		>
			<p className="font-medium text-ink-2">
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
