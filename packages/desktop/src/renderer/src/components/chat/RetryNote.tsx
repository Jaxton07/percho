import type { RetryInfo } from "@percho/shared";
import { useT } from "../../i18n";
import { WifiIcon } from "../icons";

/**
 * 自动重试瞬时状态行：灰色连接图标 + 当前重试次数，不显示等待时间。
 * SDK auto_retry_start 后出现；收到有效思考/正文或重试结束后消失，最终失败由错误卡表达。
 */
export function RetryNote({ info, summary = false }: { info: RetryInfo; summary?: boolean }) {
	const t = useT();
	return (
		<div className="retry-note text-ui-13" role="status">
			<WifiIcon size={16} />
			<span>
				{t(summary ? "compaction.retrying" : "error.retrying", {
					attempt: info.attempt,
					maxAttempts: info.maxAttempts,
				})}
			</span>
		</div>
	);
}
