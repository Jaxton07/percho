import type { McpExposure, McpServerView } from "@percho/shared";
import { useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useMcpStore } from "../../stores/mcp";
import { useSessionsStore } from "../../stores/sessions";
import { selectTranscript, useTranscriptStore } from "../../stores/transcript";

/** 表单状态（新建/编辑共用；空串 = 未填） */
interface ServerForm {
	name: string;
	command: string;
	args: string;
	url: string;
	description: string;
	scope: "user" | "project";
	exposure: McpExposure;
}

const EMPTY_FORM: ServerForm = {
	name: "",
	command: "",
	args: "",
	url: "",
	description: "",
	scope: "user",
	exposure: "deferred",
};

const inputClass =
	"w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint";
const ghostButton =
	"rounded-full px-2 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-hover hover:text-ink-2 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint";

/** 传输方式一行摘要（stdio: command args / 远程: url） */
export function transportSummary(server: McpServerView): string {
	if (server.transport.kind === "stdio") {
		return [server.transport.command, ...(server.transport.args ?? [])].join(" ");
	}
	if (server.transport.kind === "url") return server.transport.url;
	return "";
}

/** exposure 胶囊（deferred = 推荐档，用加重文字表达，不用色块） */
function ExposureChip({ server }: { server: McpServerView }) {
	const tone = server.exposure === "deferred" ? "text-ink-2" : "text-ink-faint";
	return (
		<span
			className={`shrink-0 whitespace-nowrap rounded-full bg-hover px-2 py-0.5 font-mono text-[11px] ${tone}`}
		>
			{server.exposure}
		</span>
	);
}

/** 运行态：工具数 / 未连上（连上与否看工具集合，见 mcp-inventory.ts 注释） */
function ToolsInfo({ server }: { server: McpServerView }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	if (server.tools.length === 0) {
		return <span className="text-[11px] text-ink-faint">{t("settings.mcp.noTools")}</span>;
	}
	return (
		<button type="button" className={ghostButton} onClick={() => setOpen((v) => !v)}>
			{t("settings.mcp.toolsCount", { count: server.tools.length })}
			{open && <span className="ml-2 font-mono text-[11px] text-ink-dim">{server.tools.join("，")}</span>}
		</button>
	);
}

function ServerRow({ server }: { server: McpServerView }) {
	const t = useT();
	const { upsert, remove, reload } = useMcpStore();
	// 运行中（streaming）不重连：reload 会 session_shutdown → 官方 mcp 扩展关连接、旧 runner 被废弃（见后端注释）
	const activeId = useSessionsStore((s) => s.activeSessionId);
	const running = useTranscriptStore((s) =>
		activeId ? selectTranscript(s, activeId).phase === "streaming" : false,
	);
	const [editing, setEditing] = useState(false);
	const [form, setForm] = useState<ServerForm | null>(null);
	const [confirmRemove, setConfirmRemove] = useState(false);

	const startEdit = () => {
		setForm({
			name: server.name,
			command: server.transport.kind === "stdio" ? server.transport.command : "",
			args: server.transport.kind === "stdio" ? (server.transport.args ?? []).join(" ") : "",
			url: server.transport.kind === "url" ? server.transport.url : "",
			description: server.description ?? "",
			scope: server.source,
			exposure: server.exposureRaw ?? server.exposure,
		});
		setEditing(true);
	};

	const transportLabel =
		server.transport.kind === "stdio"
			? t("settings.mcp.transportStdio")
			: server.transport.kind === "url"
				? t("settings.mcp.transportUrl")
				: t("settings.mcp.transportUnknown");

	return (
		<div className="py-2.5">
			<div className="flex items-center gap-2">
				<span className="text-[13px] text-ink-2">{server.name}</span>
				<ExposureChip server={server} />
				<span className="shrink-0 whitespace-nowrap text-[11px] text-ink-faint">{transportLabel}</span>
				{!server.enabled && (
					<span className="shrink-0 whitespace-nowrap text-[11px] text-ink-faint">
						{t("settings.mcp.disabled")}
					</span>
				)}
				<span className="flex-1" />
				<ToolsInfo server={server} />
			</div>
			{/* 操作单独一行：720px 弹窗的内容区窄，挤一行会逐字换行 */}
			<div className="mt-1 flex items-center justify-end gap-1">
				{server.exposureRaw !== "deferred" && (
					<button
						type="button"
						className={ghostButton}
						onClick={() =>
							void upsert({
								scope: server.source,
								cwd: currentCwd(),
								name: server.name,
								exposure: "deferred",
							})
						}
					>
						{t("settings.mcp.makeDeferred")}
					</button>
				)}
				<button
					type="button"
					className={`${ghostButton} whitespace-nowrap`}
					disabled={running}
					title={running ? t("settings.mcp.reconnectRunning") : undefined}
					onClick={() => void reload(currentCwd())}
				>
					{t("settings.mcp.reconnect")}
				</button>
				<button type="button" className={`${ghostButton} whitespace-nowrap`} onClick={startEdit}>
					{t("settings.mcp.edit")}
				</button>
				<button
					type="button"
					className={ghostButton}
					onClick={() => {
						if (!confirmRemove) {
							setConfirmRemove(true);
							return;
						}
						void remove({ scope: server.source, cwd: currentCwd(), name: server.name });
					}}
				>
					{confirmRemove ? t("settings.mcp.removeConfirm") : t("settings.mcp.remove")}
				</button>
			</div>
			{transportSummary(server) && (
				<p className="mt-1 font-mono text-[11.5px] text-ink-dim">{transportSummary(server)}</p>
			)}
			{server.description && <p className="mt-0.5 text-[11px] text-ink-faint">{server.description}</p>}
			{editing && form && (
				<ServerFormFields
					form={form}
					onChange={setForm}
					lockName
					onCancel={() => setEditing(false)}
					onSubmit={async () => {
						await upsert(toInput(form, server.name));
						setEditing(false);
					}}
				/>
			)}
		</div>
	);
}

/** 当前活跃项目的 cwd（项目级配置写这里）；无活跃会话时 undefined = 只能改全局 */
function currentCwd(): string | undefined {
	const { sessions, activeSessionId } = useSessionsStore.getState();
	return sessions.find((s) => s.sessionId === activeSessionId)?.cwd;
}

function toInput(form: ServerForm, nameOverride?: string) {
	const args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined;
	return {
		scope: form.scope,
		cwd: currentCwd(),
		name: nameOverride ?? form.name.trim(),
		command: form.command.trim() || undefined,
		args,
		url: form.url.trim() || undefined,
		description: form.description,
		exposure: form.exposure,
	};
}

/** 表单字段（新建与编辑共用；编辑时 name 锁定 —— 它是 mcp.json 的键、也是工具名前缀） */
function ServerFormFields({
	form,
	onChange,
	onSubmit,
	onCancel,
	lockName,
	error,
}: {
	form: ServerForm;
	onChange: (form: ServerForm) => void;
	onSubmit: () => Promise<void>;
	onCancel: () => void;
	lockName?: boolean;
	error?: string | null;
}) {
	const t = useT();
	const [submitting, setSubmitting] = useState(false);
	const field = (
		label: string,
		key: keyof ServerForm,
		extra?: { placeholder?: string; disabled?: boolean },
	) => (
		<label className="block">
			<span className="mb-1 block text-[11px] text-ink-faint">{label}</span>
			<input
				className={inputClass}
				value={form[key] as string}
				disabled={extra?.disabled}
				placeholder={extra?.placeholder}
				onChange={(event) => onChange({ ...form, [key]: event.target.value })}
			/>
		</label>
	);

	return (
		<div className="mt-3 space-y-2.5 rounded-lg bg-surface p-3">
			{field(t("settings.mcp.name"), "name", { disabled: lockName, placeholder: "demo" })}
			<label className="block">
				<span className="mb-1 block text-[11px] text-ink-faint">{t("settings.mcp.scope")}</span>
				<select
					className={inputClass}
					value={form.scope}
					disabled={lockName}
					onChange={(event) => onChange({ ...form, scope: event.target.value as ServerForm["scope"] })}
				>
					<option value="user">{t("settings.mcp.globalSection")}</option>
					<option value="project">{t("settings.mcp.projectSection")}</option>
				</select>
			</label>
			{field(t("settings.mcp.command"), "command", { placeholder: "/opt/homebrew/bin/npx" })}
			<p className="text-[11px] text-ink-faint">{t("settings.mcp.commandHint")}</p>
			{field(t("settings.mcp.args"), "args", { placeholder: "-y @modelcontextprotocol/server-everything" })}
			{field(t("settings.mcp.url"), "url", { placeholder: "https://example.com/mcp" })}
			{field(t("settings.mcp.description"), "description")}
			<label className="block">
				<span className="mb-1 block text-[11px] text-ink-faint">{t("settings.mcp.exposure")}</span>
				<select
					className={inputClass}
					value={form.exposure}
					onChange={(event) => onChange({ ...form, exposure: event.target.value as McpExposure })}
				>
					<option value="deferred">{t("settings.mcp.exposureDeferred")}</option>
					<option value="codemode">{t("settings.mcp.exposureCodemode")}</option>
					<option value="direct">{t("settings.mcp.exposureDirect")}</option>
					<option value="model-only">{t("settings.mcp.exposureModelOnly")}</option>
					<option value="hidden">{t("settings.mcp.exposureHidden")}</option>
				</select>
				<span className="mt-1 block text-[11px] text-ink-faint">{t("settings.mcp.exposureHint")}</span>
			</label>
			{error && <p className="text-[11px] text-err">{error}</p>}
			<div className="flex items-center gap-2 pt-1">
				<button
					type="button"
					className="rounded-full bg-hover px-3 py-1 text-[11px] text-ink-2 transition-colors hover:text-ink disabled:opacity-50"
					disabled={submitting}
					onClick={async () => {
						setSubmitting(true);
						try {
							await onSubmit();
						} finally {
							setSubmitting(false);
						}
					}}
				>
					{t("settings.mcp.save")}
				</button>
				<button type="button" className={ghostButton} onClick={onCancel}>
					{t("settings.mcp.cancel")}
				</button>
			</div>
		</div>
	);
}

function AddServer() {
	const t = useT();
	const { upsert } = useMcpStore();
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<ServerForm>(EMPTY_FORM);
	const [error, setError] = useState<string | null>(null);

	if (!open) {
		return (
			<button type="button" className={ghostButton} onClick={() => setOpen(true)}>
				{t("settings.mcp.add")}
			</button>
		);
	}
	return (
		<ServerFormFields
			form={form}
			error={error}
			onChange={(next) => {
				setForm(next);
				setError(null);
			}}
			onCancel={() => {
				setOpen(false);
				setForm(EMPTY_FORM);
				setError(null);
			}}
			onSubmit={async () => {
				if (!form.name.trim()) {
					setError(t("settings.mcp.needName"));
					return;
				}
				if (!form.command.trim() && !form.url.trim()) {
					setError(t("settings.mcp.needTransport"));
					return;
				}
				try {
					await upsert(toInput(form));
					setOpen(false);
					setForm(EMPTY_FORM);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}}
		/>
	);
}

function Section({ title, servers }: { title: string; servers: McpServerView[] }) {
	return (
		<div className="mt-4">
			<h3 className="text-[11px] text-ink-faint">{title}</h3>
			<div className="mt-1 divide-y divide-border/40">
				{servers.map((server) => (
					<ServerRow key={`${server.source}:${server.name}`} server={server} />
				))}
			</div>
		</div>
	);
}

/** MCP 设置面板：mcp.json 的增删改 + 运行态工具集（连接与 ${VAR} 展开都交给官方内置 mcp 扩展） */
export function McpPanel() {
	const t = useT();
	const { config, loading, load, applyToolsChanged, lastReload } = useMcpStore();
	const sessions = useSessionsStore((s) => s.sessions);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const cwd = sessions.find((s) => s.sessionId === activeSessionId)?.cwd;

	useEffect(() => {
		void load(cwd);
	}, [load, cwd]);

	// 运行态工具集变化（官方扩展注册的 mcp__<server>__<tool>）
	useEffect(() => {
		const off = getPi().onMcpToolsChanged((payload) => applyToolsChanged(payload));
		return off;
	}, [applyToolsChanged]);

	if (!config && loading) {
		return <p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.mcp.loading")}</p>;
	}

	return (
		<div className="pb-4">
			<h3 className="mb-1 text-[13px] font-medium text-ink-2">{t("settings.mcp.title")}</h3>
			<p className="text-[11px] text-ink-faint">{t("settings.mcp.hint")}</p>
			<p className="mt-1 font-mono text-[11.5px] text-ink-dim">
				{config?.globalPath ?? ""}
				{config?.projectPath ? ` · ${config.projectPath}` : ""}
			</p>

			{config && config.errors.length > 0 && (
				<ul className="mt-3 space-y-1">
					{config.errors.map((error) => (
						<li key={error} className="text-[11px] text-err">
							{error}
						</li>
					))}
				</ul>
			)}

			{config && config.global.length === 0 && config.project.length === 0 && (
				<p className="mt-4 text-[12px] text-ink-faint">{t("settings.mcp.empty")}</p>
			)}

			{config && config.global.length > 0 && (
				<Section title={t("settings.mcp.globalSection")} servers={config.global} />
			)}
			{config && config.project.length > 0 && (
				<Section title={t("settings.mcp.projectSection")} servers={config.project} />
			)}
			{config && !config.projectTrusted && (
				<p className="mt-3 text-[11px] text-ink-faint">{t("settings.mcp.projectUntrusted")}</p>
			)}
			{config && !config.projectPath && (
				<p className="mt-3 text-[11px] text-ink-faint">{t("settings.mcp.projectNeedsCwd")}</p>
			)}
			{!cwd && <p className="mt-3 text-[11px] text-ink-faint">{t("settings.mcp.noActiveSession")}</p>}

			<div className="mt-4 flex items-center gap-3">
				<AddServer />
				<span className="text-[11px] text-ink-faint">{t("settings.mcp.reconnectHint")}</span>
			</div>
			{lastReload && (
				<p className="mt-2 text-[11px] text-ink-faint">
					{lastReload.skipped.length === 0
						? t("settings.mcp.reloadApplied", { count: lastReload.reloaded })
						: t("settings.mcp.reloadSkipped", {
								count: lastReload.skipped.length,
								reloaded: lastReload.reloaded,
							})}
				</p>
			)}
		</div>
	);
}
