import type { RetryInfo } from "@percho/shared";
import { useT } from "../../i18n";
import { RefreshIcon } from "../icons";

/**
 * 自动重试瞬时状态行（error-system 画板 ④）：无底色文字 + 琥珀旋转 glyph。
 * 只在 SDK auto_retry_start 期间出现；成功恢复则消失（不留痕），最终失败由错误卡表达。
 */
export function RetryNote({ info }: { info: RetryInfo }) {
	const t = useT();
	return (
		<div className="retry-note" role="status">
			<RefreshIcon />
			<span>
				{t("error.retrying", {
					attempt: info.attempt,
					maxAttempts: info.maxAttempts,
					delay: Math.ceil(info.delayMs / 1000),
				})}
			</span>
		</div>
	);
}
