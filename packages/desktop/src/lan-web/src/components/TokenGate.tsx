import { useState } from "react";
import { t } from "../i18n";
import { useLanStore } from "../store";

/** 令牌输入页（无 ?t= 且 localStorage 无缓存时；401 也回落到这里） */
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
		<div className="token-page">
			<div className="token-card">
				<strong>{t("token.title")}</strong>
				<div className="token-hint">{t("token.hint")}</div>
				<input
					className="token-input"
					type="password"
					autoComplete="off"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && submit()}
				/>
				{failed && <div className="token-error">{t("token.invalid")}</div>}
				<button type="button" className="token-btn" onClick={submit}>
					{t("token.open")}
				</button>
			</div>
		</div>
	);
}
