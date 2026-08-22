import { useEffect, useState } from "react";
import { ChatView } from "./components/ChatView";
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
	const name = useLanStore((s) => {
		if (!s.selected) return "";
		return s.views[s.selected]?.name ?? s.list.find((item) => item.sessionId === s.selected)?.name ?? "";
	});

	useEffect(() => {
		connect();
	}, []);

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
			{selected ? <ChatView sessionId={selected} isDark={isDark} /> : <SessionList />}
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
