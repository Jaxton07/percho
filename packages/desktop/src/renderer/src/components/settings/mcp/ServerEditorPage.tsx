import type { McpExposure, McpServerView, McpUpsertInput } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useMcpStore } from "../../../stores/mcp";
import { ArrowLeftIcon } from "../../icons";
import { parsePastedServers } from "./pure";

/** 暴露档位：三档常用平铺 + 「更多」放冷门两档（设计稿决策点 3） */
const PRIMARY_EXPOSURES: McpExposure[] = ["deferred", "codemode", "direct"];
const MORE_EXPOSURES: McpExposure[] = ["model-only", "hidden"];

interface FormState {
	name: string;
	scope: "user" | "project";
	transport: "command" | "url";
	command: string;
	args: string;
	url: string;
	description: string;
	exposure: McpExposure;
}

function formOf(server?: McpServerView): FormState {
	if (!server) {
		return {
			name: "",
			scope: "user",
			transport: "command",
			command: "",
			args: "",
			url: "",
			description: "",
			exposure: "deferred",
		};
	}
	return {
		name: server.name,
		scope: server.source,
		transport: server.transport.kind === "url" ? "url" : "command",
		command: server.transport.kind === "stdio" ? server.transport.command : "",
		args: server.transport.kind === "stdio" ? (server.transport.args ?? []).join(" ") : "",
		url: server.transport.kind === "url" ? server.transport.url : "",
		description: server.description ?? "",
		exposure: server.exposureRaw ?? server.exposure,
	};
}

const input =
	"w-full rounded-[9px] border border-border bg-canvas px-2.5 py-1.5 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-ink-faint";
const monoInput = `${input} font-mono text-[11.5px]`;
const label = "mb-1 block text-[11px] text-ink-faint";
const hint = "mt-1 text-[10.5px] leading-relaxed text-ink-faint";
const ghost =
	"rounded-full px-2.5 py-1 text-[11.5px] text-ink-faint transition-colors hover:bg-hover hover:text-ink-2";

/** 分段控件（当前值一眼可见，比下拉直观） */
function Segmented<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: { value: T; label: string; disabled?: boolean }[];
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex flex-wrap gap-1">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					disabled={option.disabled}
					className={`rounded-full px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
						option.value === value ? "bg-ink text-canvas" : "bg-hover text-ink-faint hover:text-ink-2"
					}`}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

/** 设置二级页面的左上角「← 返回」（与 Codex 的二级页一致；本面板所有子页面共用） */
export function BackBar({ title, onBack }: { title: string; onBack: () => void }) {
	return (
		<div className="mb-4">
			<button
				type="button"
				className="flex items-center gap-1 rounded-full py-0.5 pr-2 text-[11.5px] text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
				onClick={onBack}
			>
				<ArrowLeftIcon size={13} />
				<span>返回</span>
			</button>
			<h3 className="mt-2 text-[15px] font-medium text-ink">{title}</h3>
		</div>
	);
}

/**
 * 新增 / 编辑 server 的**二级页面**（不是浮层：字段多，页面能给足空间；返回在左上角）。
 * 字段刻意保持精简 —— 只覆盖「能连上」必需的信息，环境变量/工作目录这类高级项留给直接编辑 mcp.json。
 */
export function ServerEditorPage({
	server,
	cwd,
	projectTrusted,
	onBack,
}: {
	server?: McpServerView;
	cwd?: string;
	projectTrusted: boolean;
	onBack: () => void;
}) {
	const t = useT();
	const { upsert } = useMcpStore();
	const [form, setForm] = useState<FormState>(() => formOf(server));
	const [moreOpen, setMoreOpen] = useState(MORE_EXPOSURES.includes(formOf(server).exposure));
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const absolutePathHint =
		form.transport === "command" && form.command.length > 0 && !form.command.startsWith("/");
	const projectDisabled = !cwd || !projectTrusted;

	const save = async () => {
		if (!form.name.trim()) {
			setError(t("settings.mcp.needName"));
			return;
		}
		if (form.transport === "command" && !form.command.trim()) {
			setError(t("settings.mcp.needTransport"));
			return;
		}
		if (form.transport === "url" && !form.url.trim()) {
			setError(t("settings.mcp.needTransport"));
			return;
		}
		setSaving(true);
		try {
			const payload: McpUpsertInput = {
				scope: form.scope,
				cwd,
				name: server ? server.name : form.name.trim(),
				command: form.transport === "command" ? form.command.trim() : undefined,
				args: form.transport === "command" && form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
				url: form.transport === "url" ? form.url.trim() : undefined,
				description: form.description,
				exposure: form.exposure,
			};
			await upsert(payload);
			onBack();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const exposures = moreOpen ? [...PRIMARY_EXPOSURES, ...MORE_EXPOSURES] : PRIMARY_EXPOSURES;

	return (
		<div className="flex min-h-full flex-col pb-2">
			<BackBar title={server ? t("settings.mcp.editServer") : t("settings.mcp.addServer")} onBack={onBack} />

			<div className="flex flex-col gap-4">
				<div>
					<label className={label} htmlFor="mcp-name">
						{t("settings.mcp.name")}
					</label>
					<input
						id="mcp-name"
						className={input}
						value={form.name}
						disabled={!!server}
						placeholder="demo"
						onChange={(event) => {
							setForm({ ...form, name: event.target.value });
							setError(null);
						}}
					/>
					<p className={hint}>{t("settings.mcp.nameHint")}</p>
				</div>

				<div className="grid grid-cols-2 gap-4">
					<div>
						<span className={label}>{t("settings.mcp.scope")}</span>
						<Segmented
							value={form.scope}
							options={[
								{ value: "user", label: t("settings.mcp.scopeGlobal") },
								{ value: "project", label: t("settings.mcp.scopeProject"), disabled: projectDisabled },
							]}
							onChange={(scope) => setForm({ ...form, scope })}
						/>
						{projectDisabled && (
							<p className={hint}>
								{cwd ? t("settings.mcp.projectUntrusted") : t("settings.mcp.projectNeedsCwd")}
							</p>
						)}
					</div>
					<div>
						<span className={label}>{t("settings.mcp.transport")}</span>
						<Segmented
							value={form.transport}
							options={[
								{ value: "command", label: t("settings.mcp.transportCommand") },
								{ value: "url", label: t("settings.mcp.transportUrlOption") },
							]}
							onChange={(transport) => setForm({ ...form, transport })}
						/>
					</div>
				</div>

				{form.transport === "command" ? (
					<>
						<div>
							<label className={label} htmlFor="mcp-command">
								{t("settings.mcp.command")}
							</label>
							<input
								id="mcp-command"
								className={`${monoInput} ${absolutePathHint ? "border-err" : ""}`}
								value={form.command}
								placeholder="/opt/homebrew/bin/npx"
								onChange={(event) => setForm({ ...form, command: event.target.value })}
							/>
							{absolutePathHint && <p className={`${hint} text-err`}>{t("settings.mcp.absolutePathHint")}</p>}
						</div>
						<div>
							<label className={label} htmlFor="mcp-args">
								{t("settings.mcp.args")}
							</label>
							<input
								id="mcp-args"
								className={monoInput}
								value={form.args}
								placeholder="-y @modelcontextprotocol/server-everything"
								onChange={(event) => setForm({ ...form, args: event.target.value })}
							/>
						</div>
					</>
				) : (
					<div>
						<label className={label} htmlFor="mcp-url">
							{t("settings.mcp.url")}
						</label>
						<input
							id="mcp-url"
							className={monoInput}
							value={form.url}
							placeholder="https://example.com/mcp"
							onChange={(event) => setForm({ ...form, url: event.target.value })}
						/>
					</div>
				)}

				<div>
					<label className={label} htmlFor="mcp-desc">
						{t("settings.mcp.description")}
					</label>
					<input
						id="mcp-desc"
						className={input}
						value={form.description}
						onChange={(event) => setForm({ ...form, description: event.target.value })}
					/>
				</div>

				<div>
					<span className={label}>{t("settings.mcp.exposure")}</span>
					<Segmented
						value={form.exposure as McpExposure | "more"}
						options={[
							...exposures.map((exposure) => ({
								value: exposure as McpExposure | "more",
								label: t(`settings.mcp.exposureShort.${exposure}`),
							})),
							...(moreOpen ? [] : [{ value: "more" as McpExposure | "more", label: t("settings.mcp.more") }]),
						]}
						onChange={(value) => {
							if (value === "more") {
								setMoreOpen(true);
								return;
							}
							setForm({ ...form, exposure: value });
						}}
					/>
					<p className={hint}>{t(`settings.mcp.exposureExplain.${form.exposure}`)}</p>
				</div>
			</div>

			<p className={`${hint} mt-4`}>{t("settings.mcp.advancedHint")}</p>
			{error && <p className="mt-3 text-[11.5px] text-err">{error}</p>}

			<div className="mt-auto flex items-center gap-1.5 pt-6">
				<span className="flex-1" />
				<button type="button" className={ghost} onClick={onBack}>
					{t("settings.mcp.cancel")}
				</button>
				<button
					type="button"
					disabled={saving}
					className="rounded-full bg-ink px-3.5 py-1.5 text-[11.5px] text-canvas disabled:opacity-50"
					onClick={() => void save()}
				>
					{t("settings.mcp.save")}
				</button>
			</div>
		</div>
	);
}

/** 「粘贴 JSON 配置」二级页面：把别处抄来的片段直接导入（一次性，不再逐字段填） */
export function PasteJsonPage({ cwd, onBack }: { cwd?: string; onBack: () => void }) {
	const t = useT();
	const { upsert } = useMcpStore();
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const save = async () => {
		const parsed = parsePastedServers(text);
		if (parsed.error) {
			setError(parsed.error);
			return;
		}
		setSaving(true);
		try {
			for (const entry of parsed.entries) {
				await upsert({ ...entry, scope: "user", cwd });
			}
			onBack();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex min-h-full flex-col pb-2">
			<BackBar title={t("settings.mcp.pasteJsonTitle")} onBack={onBack} />
			<textarea
				className={`${monoInput} h-[220px] resize-none`}
				value={text}
				placeholder={
					'{\n  "mcpServers": {\n    "demo": { "command": "/opt/homebrew/bin/npx", "args": ["-y", "…"] }\n  }\n}'
				}
				onChange={(event) => {
					setText(event.target.value);
					setError(null);
				}}
			/>
			<p className={hint}>{t("settings.mcp.pasteJsonHint")}</p>
			{error && <p className="mt-2 text-[11.5px] text-err">{error}</p>}
			<div className="mt-auto flex items-center gap-1.5 pt-6">
				<span className="flex-1" />
				<button type="button" className={ghost} onClick={onBack}>
					{t("settings.mcp.cancel")}
				</button>
				<button
					type="button"
					disabled={saving || text.trim().length === 0}
					className="rounded-full bg-ink px-3.5 py-1.5 text-[11.5px] text-canvas disabled:opacity-50"
					onClick={() => void save()}
				>
					{t("settings.mcp.pasteJsonSave")}
				</button>
			</div>
		</div>
	);
}
