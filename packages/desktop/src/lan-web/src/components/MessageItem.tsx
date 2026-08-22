import { LAN_IMAGE_PLACEHOLDER, type StreamingState, type UIMessage } from "@percho/shared";
import { t } from "../i18n";
import { Markdown } from "./Markdown";
import { SubagentCard } from "./SubagentCard";
import { ToolCard } from "./ToolCard";

/** 图片占位块（sanitize 后 data 为哨兵值；lan-web 不传输 base64 图片） */
function ImageTiles({ count }: { count: number }) {
	return (
		<div className="msg-image-tiles">
			{Array.from({ length: count }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 占位块完全同构且永不重排
				<div key={i} className="image-placeholder">
					<span>{t("chat.imagePlaceholder")}</span>
					<span style={{ fontSize: 10 }}>{t("chat.imageHidden")}</span>
				</div>
			))}
		</div>
	);
}

function ThinkingBlock({ text }: { text: string }) {
	if (!text) return null;
	return (
		<details className="msg-thinking drawer-details">
			<summary>Thinking</summary>
			<pre>{text}</pre>
		</details>
	);
}

function CompactMessage({ message }: { message: Extract<UIMessage, { kind: "system" }> }) {
	const compact = message.compact;
	if (!compact) {
		return <div className="msg-system msg-enter">{message.mutex ? t("mutex.notice") : message.text}</div>;
	}
	const label =
		compact.status === "running"
			? t("compact.running")
			: compact.status === "cancelled"
				? t("compact.cancelled")
				: compact.status === "error"
					? `${t("compact.failed")}${compact.errorMessage ? `：${compact.errorMessage}` : ""}`
					: t("compact.done");
	return (
		<div className="msg-system msg-enter">
			<span>{label}</span>
			{compact.summary && (
				<details className="compact-summary">
					<summary style={{ display: "inline" }}>·</summary>
					<div style={{ fontSize: 12 }}>{compact.summary}</div>
				</details>
			)}
		</div>
	);
}

/** 单条消息渲染（按 kind 分发）。enter=false 时跳过入场动画（种子历史消息）。 */
export function MessageItem({
	message,
	isDark,
	enter = true,
}: {
	message: UIMessage;
	isDark: boolean;
	enter?: boolean;
}) {
	const cls = enter ? " msg-enter" : "";
	switch (message.kind) {
		case "user":
			return (
				<div className={`msg-user${cls}`}>
					{message.skill && (
						<div className="msg-skill">
							/{message.skill.name}
							{message.skill.args ? ` ${message.skill.args}` : ""}
						</div>
					)}
					{message.images.length > 0 && (
						<div style={{ marginBottom: message.text ? 6 : 0 }}>
							<ImageTiles count={message.images.length} />
						</div>
					)}
					{message.text}
				</div>
			);
		case "assistant":
			return (
				<div className={`msg-assistant${cls}`}>
					<ThinkingBlock text={message.thinking} />
					{message.text && <Markdown text={message.text} isDark={isDark} />}
					{message.tools.map((tool) => (
						<ToolCard key={tool.key} tool={tool} />
					))}
				</div>
			);
		case "error":
			return <div className={`msg-error${cls}`}>{message.text}</div>;
		case "system":
			return <CompactMessage message={message} />;
		case "image":
			return (
				<div className={`msg-assistant${cls}`}>
					<ImageTiles count={message.images.length} />
				</div>
			);
		case "subagent":
			return (
				<div className={`msg-assistant${cls}`}>
					<SubagentCard runs={message.runs} />
				</div>
			);
	}
}

/** 流式中的消息（streaming 容器实时渲染：正文 markdown 流式 + 思考 + 工具卡） */
export function StreamingMessage({ streaming, isDark }: { streaming: StreamingState; isDark: boolean }) {
	if (!streaming.text && !streaming.thinking && streaming.tools.length === 0) return null;
	return (
		<div className="msg-assistant">
			<ThinkingBlock text={streaming.thinking} />
			{streaming.text && <Markdown text={streaming.text} streaming isDark={isDark} />}
			{streaming.tools.map((tool) => (
				<ToolCard key={tool.key} tool={tool} />
			))}
			{streaming.subagentRuns.length > 0 && <SubagentCard runs={streaming.subagentRuns} />}
		</div>
	);
}

/** 图片占位判定（sanitize 哨兵） */
export function isStrippedImage(data: string): boolean {
	return data === LAN_IMAGE_PLACEHOLDER;
}
