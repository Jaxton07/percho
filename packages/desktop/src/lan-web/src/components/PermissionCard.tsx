import type { PermissionRequest } from "@percho/shared";
import { useState } from "react";
import { t } from "../i18n";
import { ShieldIcon } from "./icons";

/**
 * 权限卡。M1 只读（只显示等待提示）；remoteControl=true 时显示「拒绝 / 允许一次」。
 * 远程只允许这两个动作（spec D6：allowDir/allowAlways 留在桌面端）。
 * UX v2：琥珀渐变描边卡 + 盾牌图标块 + message 整块等宽呈现（不做语法识别；
 * 全量展示不换行截断——消息可读性是功能语义，优先于设计稿的单行省略）。
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
		<div className="perm-card2">
			<div className="perm-head">
				<span className="perm-ic">
					<ShieldIcon size={16} />
				</span>
				<div>
					<div className="perm-title">{request.title}</div>
					<div className="perm-sub">{t("perm.subtitle")}</div>
				</div>
				<span className="pulse-dot amber" style={{ marginLeft: "auto" }} />
			</div>
			<div className="perm-cmd">{request.message}</div>
			{remoteControl && onRespond ? (
				<div className="perm-btns">
					<button type="button" className="pbtn" disabled={sending} onClick={() => void respond("deny")}>
						{t("perm.deny")}
					</button>
					<button
						type="button"
						className="pbtn primary"
						disabled={sending}
						onClick={() => void respond("allowOnce")}
					>
						{t("perm.allowOnce")}
					</button>
				</div>
			) : (
				<div className="perm-waiting">{t("perm.waiting")}</div>
			)}
		</div>
	);
}
