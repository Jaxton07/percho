import type { PermissionRequest } from "@percho/shared";
import { useState } from "react";
import { t } from "../i18n";

/**
 * 权限横幅。M1 只读（只显示等待提示）；remoteControl=true 时显示「允许一次/拒绝」。
 * 远程只允许这两个动作（spec D6：allowDir/allowAlways 留在桌面端）。
 */
export function PermissionCard({
	request,
	remoteControl,
	onRespond,
}: {
	request: PermissionRequest;
	remoteControl: boolean;
	onRespond?: (requestId: string, answer: "allowOnce" | "deny") => Promise<boolean>;
}) {
	const [sending, setSending] = useState(false);
	const respond = async (answer: "allowOnce" | "deny") => {
		if (!onRespond || sending) return;
		setSending(true);
		await onRespond(request.id, answer);
		setSending(false);
	};
	return (
		<div className="perm-card">
			<div className="perm-title">
				{t("perm.title")} · {request.title}
			</div>
			<div className="perm-message">{request.message}</div>
			{remoteControl && onRespond ? (
				<div className="perm-actions">
					<button
						type="button"
						className="perm-btn primary"
						disabled={sending}
						onClick={() => void respond("allowOnce")}
					>
						{t("perm.allowOnce")}
					</button>
					<button type="button" className="perm-btn" disabled={sending} onClick={() => void respond("deny")}>
						{t("perm.deny")}
					</button>
				</div>
			) : (
				<div className="perm-waiting">{t("perm.waiting")}</div>
			)}
		</div>
	);
}
