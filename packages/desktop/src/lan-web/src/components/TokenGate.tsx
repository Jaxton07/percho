import { useState } from "react";
import { t } from "../i18n";
import { useLanStore } from "../store";
import { LockIcon, XIcon } from "./icons";

/** 令牌输入页（无 ?t= 且 localStorage 无缓存时；401 也回落到这里）。
 *  UX v2：品牌 Orb 三圈涟漪 + 中央 ink 圆球、lock 图标输入框、黑白主按钮（bg-ink text-canvas）。 */
export function TokenGate() {
	const [value, setValue] = useState("");
	const [failed, setFailed] = useState(false);
	const setToken = useLanStore((s) => s.setToken);
	const submit = () => {
		const token = value.trim();
		if (!token) return;
		setFailed(false);
		setToken(token);
		// 401 时 store logout 会清回此页；这里乐观进入，失败由状态机兜底
	};
	return (
		<div className="token-wrap">
			<div className="orb">
				<span className="r1" />
				<span className="r2" />
				<span className="r3" />
				<span className="core" />
			</div>
			<div className="token-title">{t("token.title")}</div>
			<div className="token-hint">{t("token.hint")}</div>
			<div className="token-field">
				<LockIcon size={16} className="lock" />
				<input
					className="token-input"
					type="password"
					autoComplete="off"
					placeholder="••••••••"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && submit()}
				/>
			</div>
			{failed && (
				<div className="token-err">
					<XIcon size={12} />
					{t("token.invalid")}
				</div>
			)}
			<button type="button" className="token-open" onClick={submit}>
				{t("token.open")}
			</button>
		</div>
	);
}
