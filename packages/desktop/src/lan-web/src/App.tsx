import { useEffect, useState } from "react";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { ChevronLeftIcon } from "./components/icons";
import { SessionList } from "./components/SessionList";
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
			{selected ? (
				<header className="chat-nav">
					<button type="button" className="nav-back" onClick={() => select(null)} aria-label={t("chat.back")}>
						<ChevronLeftIcon size={17} />
					</button>
					<div className="titles">
						<div className="t1">{name}</div>
						<ChatStatusLine sessionId={selected} />
					</div>
					<ConnPill />
				</header>
			) : (
				<header className="nav eyebrow-row">
					<div className="eyebrow-text">{t("app.eyebrow")}</div>
					<div className="nav-main">
						<div className="nav-title">{t("list.title")}</div>
						<ConnPill />
					</div>
				</header>
			)}
			{selected ? <ChatView sessionId={selected} isDark={isDark} onRespond={onRespond} /> : <SessionList />}
			{selected && remoteControl && <Composer sessionId={selected} />}
			{!selected && <FootLine />}
		</div>
	);
}

/** 连接药丸（header 右侧）：已连接=绿 ping 光环；连接中/重连中=琥珀呼吸 */
function ConnPill() {
	const status = useLanStore((s) => s.status);
	return (
		<span className={`conn-pill${status === "connected" ? "" : " warn"}`}>
			<span className="pulse-dot" />
			{connLabel(status)}
		</span>
	);
}

/** 列表页底部居中连接行（StatusBar 拆解后仅留纯连接态；hello 帧无主机名/IP，见 spec 非目标） */
function FootLine() {
	const status = useLanStore((s) => s.status);
	return (
		<div className="foot-line">
			<span className={`pulse-dot sm${status === "connected" ? "" : " amber"}`} />
			{connLabel(status)}
		</div>
	);
}

function connLabel(status: "token" | "connecting" | "connected" | "reconnecting"): string {
	return status === "connected"
		? t("conn.connected")
		: status === "reconnecting"
			? t("conn.reconnecting")
			: t("conn.connecting");
}

/** 聊天页标题副行：等待权限（琥珀）> 工作中·工具名（紫+流光）> 压缩中（琥珀）> 空闲 / 无视图=只读 */
function ChatStatusLine({ sessionId }: { sessionId: string }) {
	const view = useLanStore((s) => s.views[sessionId]);
	const permPending = useLanStore(
		(s) => (s.pendingPerms[sessionId]?.length ?? 0) > 0 || Boolean(s.views[sessionId]?.pendingPermission),
	);
	return (
		<div className="t2">
			{!view ? (
				<>
					<span className="pulse-dot sm still" />
					{t("list.readonly")}
				</>
			) : permPending ? (
				<>
					<span className="pulse-dot sm amber" />
					{t("chat.waitingPermission")}
				</>
			) : view.agentActive ? (
				<>
					<span className="pulse-dot sm violet" />
					<span className="work-text">
						{view.currentTool ? `${t("status.working")} · ${view.currentTool}` : t("status.working")}
					</span>
				</>
			) : view.compacting ? (
				<>
					<span className="pulse-dot sm amber" />
					{t("status.compacting")}
				</>
			) : (
				<>
					<span className="pulse-dot sm" />
					{t("status.idle")}
				</>
			)}
		</div>
	);
}
