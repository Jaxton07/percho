import type { UiError } from "@percho/shared";
import { type MessageKey, useT } from "../../i18n";
import { ErrorCircleIcon, RefreshIcon } from "../icons";

/**
 * Composer 内联错误条（error-system 画板 ⑤）：QueueBar 同款悬浮卡——
 * glyph + 标题 + 副行（detail 截断单行）+ 幽灵重试按钮（重新发送）。
 */
export function SendErrorBar({ error, onRetry }: { error: UiError; onRetry: () => void }) {
	const t = useT();
	return (
		<div className="send-error mb-1.5" role="alert">
			<span className="se-glyph">
				<ErrorCircleIcon />
			</span>
			<div className="min-w-0">
				<div className="se-title truncate">{t(error.titleKey as MessageKey, error.titleParams)}</div>
				{error.detail && <div className="se-sub truncate">{error.detail}</div>}
			</div>
			{error.actions.includes("retry") && (
				<button type="button" className="se-retry" onClick={onRetry}>
					<RefreshIcon />
					{t("error.action.retry")}
				</button>
			)}
		</div>
	);
}
