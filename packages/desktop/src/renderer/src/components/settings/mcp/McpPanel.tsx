import type { McpServerView } from "@percho/shared";
import { useEffect, useState } from "react";
import { getPi } from "../../../api";
import { useT } from "../../../i18n";
import { useMcpStore } from "../../../stores/mcp";
import { useSessionsStore } from "../../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../../stores/transcript";
import { ChevronRightIcon, PlusIcon } from "../../icons";
import { filterServers, showSearch, sortServers, toolsSummary } from "./pure";
import { PasteJsonPage, ServerEditorPage } from "./ServerEditorPage";
import { ServerRow } from "./ServerRow";

/** 顶部一条常显提示（官方 notify 的全局信息 / 运行中重连）：bg-hover 圆角条 + 一枚 glyph */
function Notice({
	glyph,
	message,
	action,
	onAction,
}: {
	glyph: "warn" | "err" | "info";
	message: React.ReactNode;
	action?: string;
	onAction?: () => void;
}) {
	return (
		<div className="flex items-center gap-2.5 rounded-[10px] bg-hover px-3 py-2">
			<span
				className={`flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full text-ui-10 leading-none ${
					glyph === "err" ? "text-err" : glyph === "warn" ? "text-ink-2" : "text-ink-faint"
				}`}
			>
				{glyph === "err" ? "!" : glyph === "warn" ? "!" : "i"}
			</span>
			<span className="flex-1 text-ui-115 leading-relaxed text-ink-2">{message}</span>
			{action && (
				<button
					type="button"
					className="rounded-full px-2 py-0.5 text-ui-11 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					onClick={onAction}
				>
					{action}
				</button>
			)}
		</div>
	);
}

function Group({ title, path, children }: { title: string; path?: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="flex items-baseline gap-2 px-2.5 pb-0.5">
				<span className="text-ui-11 text-ink-faint">{title}</span>
				{path && <span className="truncate font-mono text-ui-11 text-ink-faint">{path}</span>}
			</div>
			{children}
		</div>
	);
}

/**
 * 项目上下文：读 sessions store 的 `cwd`（切会话 / 选项目时由 store 维护，与左栏 activeCwd 同一事实源）。
 *
 * 先前是「在 sessions 列表里按 activeSessionId 找 cwd」，但列表是异步加载的子集：刚打开会话、
 * 列表还没跟上时找不到那条 → cwd 为 undefined → 面板误报「当前没有打开的会话」（实测踩过）。
 * 这里分两个概念：配置读写用 `cwd`；运行态（连接/工具清单）靠会话上报，用 `hasSession` 判断。
 */
function useProjectCwd(): string | undefined {
	return useSessionsStore((s) => s.cwd ?? undefined);
}

/** 是否有活跃会话（运行态报告来源）：draft 新会话页为 null */
function useHasActiveSession(): boolean {
	return useSessionsStore((s) => s.activeSessionId !== null);
}

/** MCP 设置面板：mcp.json 的增删改 + 运行态（连接/工具/失效原因）。连接与授权都交给官方内置 mcp 扩展 */
export function McpPanel() {
	const t = useT();
	const { config, loading, load, notice, lastReload, applyServersChanged } = useMcpStore();
	const cwd = useProjectCwd();
	const hasSession = useHasActiveSession();
	/** 二级页面（不是浮层）：列表 ↔ 添加/编辑/粘贴 JSON —— 返回按钮在左上角 */
	const [view, setView] = useState<
		{ mode: "add" } | { mode: "edit"; server: McpServerView } | { mode: "paste" } | null
	>(null);
	const [query, setQuery] = useState("");
	const [runningDismissed, setRunningDismissed] = useState(false);
	const [pathsOpen, setPathsOpen] = useState(false);
	const activeId = useSessionsStore((s) => s.activeSessionId);
	const running = useTranscriptStore((s) =>
		activeId ? selectTranscript(s, activeId).phase === "streaming" : false,
	);

	useEffect(() => {
		void load(cwd);
	}, [load, cwd]);

	useEffect(() => {
		const off = getPi().onMcpServersChanged((payload) => applyServersChanged(payload));
		return off;
	}, [applyServersChanged]);

	const servers = sortServers([...(config?.global ?? []), ...(config?.project ?? [])]);
	const projectTrusted = config?.projectTrusted ?? false;
	const toolCount = servers.reduce((sum, server) => sum + (toolsSummary(server.tools)?.count ?? 0), 0);
	const connected = servers.filter((server) => serverStateConnected(server)).length;
	const visible = (servers: McpServerView[]) => filterServers(sortServers(servers), query);

	if (!config && loading) {
		return <p className="py-8 text-center text-ui-13 text-ink-faint">{t("settings.mcp.loading")}</p>;
	}

	const hasServers = (config?.global.length ?? 0) + (config?.project.length ?? 0) > 0;

	if (view) {
		return (
			<div className="flex min-h-full flex-col pb-2">
				{view.mode === "paste" ? (
					<PasteJsonPage cwd={cwd} onBack={() => setView(null)} />
				) : (
					<ServerEditorPage
						server={view.mode === "edit" ? view.server : undefined}
						cwd={cwd}
						projectTrusted={projectTrusted}
						onBack={() => setView(null)}
					/>
				)}
			</div>
		);
	}

	return (
		<div className="relative flex min-h-full flex-col pb-2">
			{/* 面板头：只回答「连上几台 / 几个工具」 */}
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<h3 className="text-ui-13 font-medium text-ink-2">{t("settings.mcp.title")}</h3>
					<p className="mt-0.5 text-ui-11 text-ink-faint">
						{hasServers
							? t("settings.mcp.summary", { connected, total: servers.length, tools: toolCount })
							: t("settings.mcp.hint")}
					</p>
				</div>
				<button
					type="button"
					className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-ui-11 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					onClick={() => setView({ mode: "add" })}
				>
					<PlusIcon size={12} /> {t("settings.mcp.addServer")}
				</button>
			</div>

			{/* 官方 notify 的全局提示（工具不可达 / 配置错误） */}
			{notice && (
				<div className="mt-3">
					<Notice
						glyph={notice.level === "error" ? "err" : notice.level === "warning" ? "warn" : "info"}
						message={notice.message}
					/>
				</div>
			)}

			{/* 运行中：重连会打断当前会话，这里把原因说出来（不是 hover title） */}
			{running && !runningDismissed && (
				<div className="mt-3">
					<Notice
						glyph="warn"
						message={t("settings.mcp.runningNotice")}
						action={t("settings.mcp.gotIt")}
						onAction={() => setRunningDismissed(true)}
					/>
				</div>
			)}

			{/* 配置错误（形状不对 / 读写失败） */}
			{config && config.errors.length > 0 && (
				<ul className="mt-2.5 space-y-1">
					{config.errors.map((error) => (
						<li key={error} className="text-ui-11 text-err">
							{error}
						</li>
					))}
				</ul>
			)}

			{/* 搜索：服务器 > 8 个才出现 */}
			{showSearch(servers) && (
				<input
					className="mt-3 w-full rounded-[9px] border border-border bg-canvas px-2.5 py-1.5 text-ui-12 text-ink outline-none placeholder:text-ink-faint focus:border-ink-faint"
					value={query}
					placeholder={t("settings.mcp.searchPlaceholder")}
					onChange={(event) => setQuery(event.target.value)}
				/>
			)}

			{/* 空态 */}
			{!hasServers && (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
					<p className="text-ui-13 text-ink-2">{t("settings.mcp.emptyTitle")}</p>
					<p className="max-w-[380px] text-ui-115 leading-relaxed text-ink-faint">
						{t("settings.mcp.emptyDesc")}
					</p>
					<div className="mt-1.5 flex items-center gap-1.5">
						<button
							type="button"
							className="rounded-full bg-ink px-3.5 py-1.5 text-ui-115 text-canvas"
							onClick={() => setView({ mode: "add" })}
						>
							{t("settings.mcp.addServer")}
						</button>
						<button
							type="button"
							className="rounded-full px-2.5 py-1 text-ui-115 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
							onClick={() => setView({ mode: "paste" })}
						>
							{t("settings.mcp.pasteJson")}
						</button>
					</div>
				</div>
			)}

			{/* 分组列表 */}
			{hasServers && (
				<div className="mt-3 flex flex-col gap-3">
					{visible(config?.global ?? []).length > 0 && (
						<Group title={t("settings.mcp.groupGlobal")}>
							{visible(config?.global ?? []).map((server) => (
								<ServerRow
									key={`user:${server.name}`}
									server={server}
									cwd={cwd}
									onEdit={(s) => setView({ mode: "edit", server: s })}
								/>
							))}
						</Group>
					)}
					{(config?.project.length ?? 0) > 0 && (
						<Group title={t("settings.mcp.groupProject")} path={config?.projectPath}>
							{visible(config?.project ?? []).map((server) => (
								<ServerRow
									key={`project:${server.name}`}
									server={server}
									cwd={cwd}
									onEdit={(s) => setView({ mode: "edit", server: s })}
								/>
							))}
						</Group>
					)}
					{config && !config.projectTrusted && config.projectPath && (
						<p className="px-2.5 text-ui-11 text-ink-faint">{t("settings.mcp.projectUntrusted")}</p>
					)}
					{!hasSession && (
						<p className="px-2.5 text-ui-11 text-ink-faint">{t("settings.mcp.noActiveSession")}</p>
					)}
				</div>
			)}

			{/* 页脚：运维信息收进来（默认折叠）+ 最近一次重连结果 */}
			<div className="mt-auto flex items-center gap-2 pt-4">
				<button
					type="button"
					className="flex items-center gap-1 rounded-full py-0.5 pl-1 pr-2 text-ui-11 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					onClick={() => setPathsOpen((v) => !v)}
				>
					<ChevronRightIcon
						className={pathsOpen ? "rotate-90 transition-transform" : "transition-transform"}
					/>
					{t("settings.mcp.configFiles")}
				</button>
				<span className="flex-1" />
				{lastReload && (
					<span className="text-ui-11 text-ink-faint">
						{lastReload.skipped.length === 0
							? t("settings.mcp.reloadApplied", { count: lastReload.reloaded })
							: t("settings.mcp.reloadSkipped", {
									count: lastReload.skipped.length,
									reloaded: lastReload.reloaded,
								})}
					</span>
				)}
			</div>
			{pathsOpen && config && (
				<div className="mt-1 flex flex-col gap-1">
					<div className="flex items-center gap-2 font-mono text-ui-115 text-ink-dim">
						<span className="w-[52px] shrink-0 text-ui-11 text-ink-faint">
							{t("settings.mcp.pathGlobal")}
						</span>
						<span className="truncate">{config.globalPath}</span>
					</div>
					{config.projectPath && (
						<div className="flex items-center gap-2 font-mono text-ui-115 text-ink-dim">
							<span className="w-[52px] shrink-0 text-ui-11 text-ink-faint">
								{t("settings.mcp.pathProject")}
							</span>
							<span className="truncate">{config.projectPath}</span>
						</div>
					)}
					<p className="text-ui-11 leading-relaxed text-ink-faint">{t("settings.mcp.reloadExplain")}</p>
				</div>
			)}
		</div>
	);
}

function serverStateConnected(server: McpServerView): boolean {
	return server.enabled && server.tools.length > 0 && !server.error;
}
