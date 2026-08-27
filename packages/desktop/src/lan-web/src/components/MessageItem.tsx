import { LAN_IMAGE_PLACEHOLDER, type UIMessage } from "@percho/shared";
import { type LanI18nKey, t } from "../i18n";
import { ChevronRightIcon, ImageIcon } from "./icons";
import { Markdown } from "./Markdown";
import { SubagentCard } from "./SubagentCard";
import { ToolCard } from "./ToolCard";

/** 图片占位块（sanitize 后 data 为哨兵值；lan-web 不传输 base64 图片）。UX v2：🖼 emoji → SVG。 */
function ImageTiles({ count }: { count: number }) {
	return (
		<div className="img-tiles">
			{Array.from({ length: count }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: 占位块完全同构且永不重排
				<div key={i} className="img-ph">
					<ImageIcon size={20} />
					<span>
						{t("chat.imagePlaceholder")}
						<br />
						{t("chat.imageHidden")}
					</span>
				</div>
			))}
		</div>
	);
}

function ThinkingBlock({ text }: { text: string }) {
	if (!text) return null;
	return (
		<details className="msg-thinking drawer-details">
			<summary>
				Thinking
				<ChevronRightIcon size={12} className="meta-caret" />
			</summary>
			<pre>{text}</pre>
		</details>
	);
}

/** error.title.* 迷你字典键（zh/en 已收录）；未知 key（未来新增）降级 error.generic */
const KNOWN_ERROR_TITLES = new Set([
	"error.title.llmAuth",
	"error.title.llmRateLimit",
	"error.title.llmOverflow",
	"error.title.llmNetwork",
	"error.title.llmGeneric",
	"error.title.streamGuard",
]);
function errorTitleKey(key: string): LanI18nKey {
	return KNOWN_ERROR_TITLES.has(key) ? (key as LanI18nKey) : "error.generic";
}

function CompactMessage({ message }: { message: Extract<UIMessage, { kind: "system" }> }) {
	const compact = message.compact;
	if (!compact) {
		return <div className="m-sys rise-in">{message.mutex ? t("mutex.notice") : message.text}</div>;
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
		<div className="m-sys rise-in">
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

/** 单条消息渲染（按 kind 分发）。enter=false 时跳过入场动画（种子历史消息）。
 *  metaInGroup：思考/工具已并入折叠组（不重复渲染）；streaming：正文走流式平滑。 */
export function MessageItem({
	message,
	isDark,
	enter = true,
	streaming = false,
	metaInGroup = false,
}: {
	message: UIMessage;
	isDark: boolean;
	enter?: boolean;
	streaming?: boolean;
	metaInGroup?: boolean;
}) {
	const cls = enter ? " rise-in" : "";
	switch (message.kind) {
		case "user":
			return (
				<div className={`m-user${cls}`}>
					{message.skill && (
						<div className="skill-tag">
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
				<div className={`m-assistant${cls}`}>
					{!metaInGroup && <ThinkingBlock text={message.thinking} />}
					{message.text && <Markdown text={message.text} isDark={isDark} streaming={streaming} />}
					{!metaInGroup && message.tools.map((tool) => <ToolCard key={tool.key} tool={tool} />)}
				</div>
			);
		case "error":
			// 统一报错信封（共用 reducer 自动派发）；LAN 迷你字典没有 error.* 全量
			// 密钥，标题用 titleKey 的中文兜底（仅当已知 key 时翻译，否则原文 key）
			return (
				<div className={`m-err${cls}`}>
					<div className="m-err-title">{t(errorTitleKey(message.error.titleKey))}</div>
					{message.error.detail && <pre className="m-err-detail">{message.error.detail}</pre>}
				</div>
			);
		case "system":
			return <CompactMessage message={message} />;
		case "image":
			return (
				<div className={`m-assistant${cls}`}>
					<ImageTiles count={message.images.length} />
				</div>
			);
		case "subagent":
			return (
				<div className={`m-assistant${cls}`}>
					<SubagentCard runs={message.runs} />
				</div>
			);
	}
}

/** 图片占位判定（sanitize 哨兵） */
export function isStrippedImage(data: string): boolean {
	return data === LAN_IMAGE_PLACEHOLDER;
}
