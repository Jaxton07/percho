import { useEffect, useState } from "react";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { SessionList } from "./components/SessionList";
import { StatusBar } from "./components/StatusBar";
import { TokenGate } from "./components/TokenGate";
import { t } from "./i18n";
import { connect, useLanStore } from "./store";

function useIsDark(): boolean {
	const [isDark, setIsDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			setIsDark(mq.matches);
			document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
		};
		onChange();
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	return isDark;
}

export function App() {
	const isDark = useIsDark();
	const status = useLanStore((s) => s.status);
	const selected = useLanStore((s) => s.selected);
	const select = useLanStore((s) => s.select);
	const remoteControl = useLanStore((s) => s.remoteControl);
	const respondPermission = useLanStore((s) => s.respondPermission);
	const name = useLanStore((s) => {
		if (!s.selected) return "";
		return s.views[s.selected]?.name ?? s.list.find((item) => item.sessionId === s.selected)?.name ?? "";
	});

	useEffect(() => {
		connect();
	}, []);

	// 权限应答（M2）：失败时 PermissionCard 恢复可点（perm 帧仍未决，可重试）
	const onRespond = async (requestId: string, answer: "allowOnce" | "deny") => {
		return (await respondPermission(requestId, answer)) === null;
	};

	if (status === "token") {
		return (
			<div className="app">
				<TokenGate />
			</div>
		);
	}

	return (
		<div className="app">
			<header className="app-header">
				{selected && (
					<button type="button" className="back-btn" onClick={() => select(null)} aria-label={t("chat.back")}>
						‹
					</button>
				)}
				<div className="app-title">{selected ? name : t("app.title")}</div>
				<ConnBadge />
			</header>
			{selected ? <ChatView sessionId={selected} isDark={isDark} onRespond={onRespond} /> : <SessionList />}
			{selected && remoteControl && <Composer sessionId={selected} />}
			<StatusBar sessionId={selected} />
		</div>
	);
}

function ConnBadge() {
	const status = useLanStore((s) => s.status);
	return (
		<span className="conn">
			<span className={`conn-dot ${status === "connected" ? "ok" : "bad"}`} />
			{status === "connected"
				? t("conn.connected")
				: status === "reconnecting"
					? t("conn.reconnecting")
					: t("conn.connecting")}
		</span>
	);
}
