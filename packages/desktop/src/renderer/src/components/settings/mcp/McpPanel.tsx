import type { McpServerView } from "@percho/shared";
import { environmentEntityRef, environmentKey, LOCAL_ENVIRONMENT, sameEnvironment } from "@percho/shared";
import { useEffect, useState } from "react";
import { getExecutionApi } from "../../../environment-api";
import { useEnvironment } from "../../../environment-context";
import { useT } from "../../../i18n";
import { selectActiveCwd } from "../../../lib/active-cwd";
import { useMcpStore } from "../../../stores/mcp";
import { useSessionsStore } from "../../../stores/sessions";
import { ChevronRightIcon, PlusIcon } from "../../icons";
import { filterServers, serverState, showSearch, sortServers, toolsSummary } from "./pure";
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

function Group({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="flex items-baseline gap-2 px-2.5 pb-0.5">
				<span className="text-ui-11 text-ink-faint">{title}</span>
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
 * 目录用于配置及操作目标归属；运行实例由后端报告，不必常显上下文信息。
 */
function useProjectCwd(): string | undefined {
	const environment = useEnvironment();
	return useSessionsStore((s) => {
		const owner = s.activeSessionId
			? environmentEntityRef(s.activeSessionId).environment
			: s.newSessionDraft
				? (s.newSessionDraft.environment ?? LOCAL_ENVIRONMENT)
				: undefined;
		if (!owner || !sameEnvironment(owner, environment)) return undefined;
		const cwd = selectActiveCwd(s);
		const ref = cwd ? environmentEntityRef(cwd) : undefined;
		return ref && sameEnvironment(ref.environment, environment) ? ref.id : undefined;
	});
}

/** MCP 设置面板：mcp.json 的增删改 + 运行态（连接/工具/失效原因）。连接与授权都交给官方内置 mcp 扩展 */
export function McpPanel() {
	const t = useT();
	const environment = useEnvironment();
	const {
		config,
		loading,
		load,
		notice,
		restartRequired,
		applyServersChanged,
		selectedInstanceId,
		selectInstance,
	} = useMcpStore();
	const cwd = useProjectCwd();
	/** 二级页面（不是浮层）：列表 ↔ 添加/编辑/粘贴 JSON —— 返回按钮在左上角 */
	const [view, setView] = useState<
		{ mode: "add" } | { mode: "edit"; server: McpServerView } | { mode: "paste" } | null
	>(null);
	const [query, setQuery] = useState("");
	const [detailsOpen, setDetailsOpen] = useState(false);
	const activeId = useSessionsStore((s) => s.activeSessionId);

	useEffect(() => {
		const ref = activeId ? environmentEntityRef(activeId) : undefined;
		void load(cwd, ref && sameEnvironment(ref.environment, environment) ? ref.id : undefined);
	}, [load, cwd, activeId, environment]);

	useEffect(() => {
		const off = getExecutionApi(environment).onMcpServersChanged((payload) => applyServersChanged(payload));
		return off;
	}, [applyServersChanged, environment]);

	const servers = sortServers([...(config?.global ?? []), ...(config?.project ?? [])]);
	const projectTrusted = config?.projectTrusted ?? false;
	const toolCount = servers.reduce((sum, server) => sum + (toolsSummary(server.tools)?.count ?? 0), 0);
	const connected = servers.filter((server) => serverStateConnected(server)).length;
	const visible = (servers: McpServerView[]) => filterServers(sortServers(servers), query);
	const candidates =
		config?.runtime?.instances.filter((instance) => instance.cwd === config.contextCwd) ?? [];
	const selectedEnded =
		typeof selectedInstanceId === "string" &&
		!candidates.some((instance) => instance.instanceId === selectedInstanceId);
	const needsSelection = candidates.length > 0 && !config?.selectedInstanceId;
	const sessionPicker =
		candidates.length > 0 ? (
			<select
				aria-label={t("settings.mcp.chooseSession")}
				className="rounded-full bg-hover px-2 py-1 text-ink-2"
				value={config?.selectedInstanceId ?? ""}
				onChange={(event) => selectInstance(event.target.value || null)}
			>
				<option value="">
					{selectedEnded ? t("settings.mcp.instanceEnded") : t("settings.mcp.chooseSession")}
				</option>
				{candidates.map((instance) => (
					<option key={instance.instanceId} value={instance.instanceId}>
						{instance.sessionId.slice(0, 8)}
					</option>
				))}
			</select>
		) : (
			<span>{selectedEnded ? t("settings.mcp.instanceEnded") : t("settings.mcp.noInstance")}</span>
		);

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

			{needsSelection && !detailsOpen && (
				<div className="mt-3 text-ui-11 text-ink-faint">{sessionPicker}</div>
			)}
			{config?.runtimeErrors?.map((error) => (
				<p key={error} className="mt-2 text-ui-11 text-err">
					{error}
				</p>
			))}

			{/* 官方 notify 的全局提示（工具不可达 / 配置错误） */}
			{notice && (
				<div className="mt-3">
					<Notice
						glyph={notice.level === "error" ? "err" : notice.level === "warning" ? "warn" : "info"}
						message={notice.message}
					/>
				</div>
			)}

			{restartRequired && config && (
				<div className="mt-3">
					<Notice
						glyph="info"
						message={t(
							environment.kind === "local"
								? "settings.mcp.restartRequired"
								: "settings.mcp.restartRequiredRemote",
						)}
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
									key={`${environmentKey(environment)}:user:${server.name}:${selectedInstanceId ?? ""}`}
									server={server}
									cwd={cwd}
									onEdit={(s) => setView({ mode: "edit", server: s })}
								/>
							))}
						</Group>
					)}
					{(config?.project.length ?? 0) > 0 && (
						<Group title={t("settings.mcp.groupProject")}>
							{visible(config?.project ?? []).map((server) => (
								<ServerRow
									key={`${environmentKey(environment)}:project:${server.name}:${selectedInstanceId ?? ""}`}
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
				</div>
			)}

			{/* 上下文及配置路径默认收起，不影响原有会话归属与选择。 */}
			<div className="mt-auto flex items-center gap-2 pt-4">
				<button
					type="button"
					className="flex items-center gap-1 rounded-full py-0.5 pl-1 pr-2 text-ui-11 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					aria-expanded={detailsOpen}
					onClick={() => setDetailsOpen((v) => !v)}
				>
					<ChevronRightIcon
						className={detailsOpen ? "rotate-90 transition-transform" : "transition-transform"}
					/>
					{t("settings.mcp.details")}
				</button>
				<span className="flex-1" />
			</div>
			{detailsOpen && config && (
				<section aria-label={t("settings.mcp.details")} className="mt-1 flex flex-col gap-2">
					<div className="flex items-start gap-2 text-ui-11 text-ink-dim">
						<span className="w-20 shrink-0 text-ink-faint">{t("settings.mcp.context")}</span>
						<span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono">
							{config.contextCwd ?? "—"}
						</span>
					</div>
					<div className="flex items-center gap-2 text-ui-11 text-ink-dim">
						<span className="w-20 shrink-0 text-ink-faint">{t("settings.mcp.sessionLabel")}</span>
						{sessionPicker}
					</div>
					<div className="flex items-start gap-2 font-mono text-ui-115 text-ink-dim">
						<span className="w-20 shrink-0 font-sans text-ui-11 text-ink-faint">
							{t("settings.mcp.pathGlobal")}
						</span>
						<span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{config.globalPath}</span>
					</div>
					{config.projectPath && (
						<div className="flex items-start gap-2 font-mono text-ui-115 text-ink-dim">
							<span className="w-20 shrink-0 font-sans text-ui-11 text-ink-faint">
								{t("settings.mcp.pathProject")}
							</span>
							<span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{config.projectPath}</span>
						</div>
					)}
				</section>
			)}
		</div>
	);
}

function serverStateConnected(server: McpServerView): boolean {
	return serverState(server) === "connected";
}
