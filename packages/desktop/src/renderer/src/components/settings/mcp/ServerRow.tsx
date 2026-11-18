import type { McpServerView } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useMcpStore } from "../../../stores/mcp";
import { useSessionsStore } from "../../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../../stores/transcript";
import { ChevronRightIcon } from "../../icons";
import { serverState, toolsSummary, transportSummary } from "./pure";

/** 状态点：7px 圆点 —— 全行只有这一枚 coloring glyph（设计稿 §3） */
function StateDot({ state }: { state: ReturnType<typeof serverState> }) {
	const cls =
		state === "connected"
			? "bg-emerald-500"
			: state === "error" || state === "failed"
				? "bg-err"
				: state === "disabled"
					? "bg-ink-faint/60"
					: "border-[1.5px] border-ink-faint bg-transparent";
	return <span className={`mt-[3px] h-[7px] w-[7px] shrink-0 rounded-full ${cls}`} />;
}

/** 无工具 / 失败 / 需登录时，在第一行给一个状态词（已连上不重复，工具数已说明） */
function StateWord({ state }: { state: ReturnType<typeof serverState> }) {
	const t = useT();
	if (state === "connected") return null;
	const keys = {
		"needs-auth": "settings.mcp.state.needAuth",
		error: "settings.mcp.state.error",
		idle: "settings.mcp.state.idle",
		disabled: "settings.mcp.state.disabled",
		"not-started": "settings.mcp.state.not-started",
		unknown: "settings.mcp.state.unknown",
		connecting: "settings.mcp.state.connecting",
		disconnected: "settings.mcp.state.disconnected",
		failed: "settings.mcp.state.failed",
		closed: "settings.mcp.state.closed",
		overridden: "settings.mcp.state.overridden",
	} as const;
	const key = keys[state];
	return (
		<span
			className={`shrink-0 text-ui-11 ${state === "error" || state === "failed" ? "text-err" : "text-ink-faint"}`}
		>
			{t(key)}
		</span>
	);
}

export function ServerRow({
	server,
	cwd,
	onEdit,
}: {
	server: McpServerView;
	cwd?: string;
	onEdit: (server: McpServerView) => void;
}) {
	const t = useT();
	const { upsert, remove, reload, login } = useMcpStore();
	const [toolsOpen, setToolsOpen] = useState(false);
	const [reasonOpen, setReasonOpen] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [loginWaiting, setLoginWaiting] = useState(false);
	const [loginError, setLoginError] = useState<string>();
	const state = serverState(server);
	const summary = toolsSummary(server.tools);
	const command = transportSummary(server);
	const activeId = useSessionsStore((s) => s.activeSessionId);
	const running = useTranscriptStore((s) =>
		activeId ? selectTranscript(s, activeId).phase === "streaming" : false,
	);
	const transportWord =
		server.transport.kind === "stdio"
			? t("settings.mcp.transportStdio")
			: server.transport.kind === "url"
				? t("settings.mcp.transportUrl")
				: t("settings.mcp.transportUnknown");
	const ghost =
		"rounded-full px-2 py-0.5 text-ui-11 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2 disabled:opacity-40 disabled:hover:bg-transparent";
	const ghostStrong = "rounded-full px-2 py-0.5 text-ui-11 text-ink transition-colors hover:bg-hover";

	return (
		<div
			className={`group/row rounded-[10px] px-2.5 py-2 transition-colors hover:bg-hover focus-within:bg-hover ${
				server.enabled ? "" : "opacity-70"
			}`}
		>
			<div className="flex items-center gap-2">
				<StateDot state={state} />
				<span className={`text-ui-13 ${server.enabled ? "text-ink-2" : "text-ink-faint"}`}>
					{server.name}
				</span>
				<span
					className={`shrink-0 rounded-full bg-hover px-2 py-0.5 font-mono text-ui-11 ${
						server.exposure === "deferred" ? "text-ink-2" : "text-ink-faint"
					}`}
				>
					{server.exposure}
				</span>
				<span className="shrink-0 whitespace-nowrap text-ui-11 text-ink-faint">{transportWord}</span>
				<StateWord state={state} />
				<span className="flex-1" />
				{state === "connected" && !summary && (
					<span className="text-ui-11 text-ink-faint">{t("settings.mcp.connectedZero")}</span>
				)}
				{summary && (
					<button type="button" className={`${ghost} shrink-0`} onClick={() => setToolsOpen((v) => !v)}>
						{t("settings.mcp.toolsCount", { count: summary.count })}
					</button>
				)}
				{(state === "error" || state === "failed" || (state === "disconnected" && server.error)) && (
					<button
						type="button"
						className={`${ghostStrong} flex shrink-0 items-center gap-1 whitespace-nowrap`}
						onClick={() => setReasonOpen((v) => !v)}
					>
						<ChevronRightIcon
							className={reasonOpen ? "rotate-90 transition-transform" : "transition-transform"}
						/>
						{reasonOpen ? t("settings.mcp.hideReason") : t("settings.mcp.viewReason")}
					</button>
				)}
				{state === "needs-auth" && !loginWaiting && (
					<button
						type="button"
						className={`${ghostStrong} shrink-0`}
						onClick={() => {
							setLoginWaiting(true);
							setLoginError(undefined);
							void login(server.name)
								.catch((error: unknown) => {
									setLoginError(error instanceof Error ? error.message : String(error));
								})
								.finally(() => setLoginWaiting(false));
						}}
					>
						{t("settings.mcp.login")}
					</button>
				)}
				{/* hover / 键盘聚焦才显形的操作组 */}
				<span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
					{server.enabled ? (
						<button
							type="button"
							className={ghost}
							disabled={running}
							title={running ? t("settings.mcp.reconnectRunning") : undefined}
							onClick={() => void reload(cwd)}
						>
							{t("settings.mcp.reconnect")}
						</button>
					) : (
						<button
							type="button"
							className={ghost}
							onClick={() => void upsert({ scope: server.source, cwd, name: server.name, enabled: true })}
						>
							{t("settings.mcp.enable")}
						</button>
					)}
					<button type="button" className={ghost} onClick={() => onEdit(server)}>
						{t("settings.mcp.edit")}
					</button>
					<button
						type="button"
						className="rounded-full px-2 py-0.5 text-ui-11 text-ink-faint transition-colors hover:bg-hover hover:text-err"
						onClick={() => setConfirming(true)}
					>
						{t("settings.mcp.remove")}
					</button>
				</span>
			</div>

			{command && (
				<p className="mt-1 truncate pl-[15px] font-mono text-ui-115 text-ink-dim" title={command}>
					{command}
				</p>
			)}
			{(server.description || (summary && summary.readOnly > 0) || (running && server.enabled)) && (
				<div className="mt-0.5 flex items-center gap-2 pl-[15px] text-ui-11 text-ink-faint">
					{server.description && <span className="truncate">{server.description}</span>}
					{server.description && summary && summary.readOnly > 0 && (
						<span className="text-ink-faint/60">·</span>
					)}
					{summary && summary.readOnly > 0 && (
						<span>{t("settings.mcp.toolsReadOnly", { count: summary.readOnly })}</span>
					)}
					{running && server.enabled && <span>{t("settings.mcp.reconnectDisabledHint")}</span>}
				</div>
			)}

			{toolsOpen && summary && (
				<div className="mb-1 ml-[15px] mt-2 rounded-[10px] bg-hover px-3 py-2.5">
					<div className="mb-1.5 text-ui-11 text-ink-faint">
						{t("settings.mcp.toolsTitle", { count: summary.count })}
					</div>
					<div className="flex flex-col gap-1">
						{server.tools.map((tool) => (
							<div key={tool.name} className="flex items-center gap-2 font-mono text-ui-115 text-ink-dim">
								<span className="text-ink-2">{tool.name}</span>
								<span className="font-sans text-ui-11 text-ink-faint">
									{tool.readOnly ? t("settings.mcp.toolReadOnly") : t("settings.mcp.toolWrite")}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{reasonOpen && server.error && (
				<div className="mb-1 ml-[15px] mt-2 rounded-[10px] bg-hover px-3 py-2.5">
					<div className="mb-1.5 text-ui-11 text-ink-faint">{t("settings.mcp.reasonTitle")}</div>
					<p className="whitespace-pre-wrap font-mono text-ui-115 text-ink-dim">{server.error}</p>
					<p className="mt-2 text-ui-11 text-ink-faint">{t("settings.mcp.reasonHint")}</p>
				</div>
			)}

			{(loginWaiting || loginError) && (
				<div className="mb-1 ml-[15px] mt-2 rounded-[10px] bg-hover px-3 py-2.5 text-ui-115 text-ink-dim">
					{loginError ?? t("settings.mcp.loginWaiting")}
				</div>
			)}

			{confirming && (
				<div className="mb-1 ml-[15px] mt-2 flex items-center gap-2 rounded-[10px] bg-hover px-3 py-2">
					<span className="flex-1 text-ui-115 text-ink-2">
						{t("settings.mcp.deleteAsk", { name: server.name })}
					</span>
					<button type="button" className={ghost} onClick={() => setConfirming(false)}>
						{t("settings.mcp.cancel")}
					</button>
					<button
						type="button"
						className="rounded-full px-2 py-0.5 text-ui-11 text-err transition-colors hover:bg-hover"
						onClick={() => {
							setConfirming(false);
							void remove({ scope: server.source, cwd, name: server.name });
						}}
					>
						{t("settings.mcp.deleteNow")}
					</button>
				</div>
			)}
		</div>
	);
}
