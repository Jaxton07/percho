import type { McpExposure, McpServerView, McpUpsertInput } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useMcpStore } from "../../../stores/mcp";
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
const subLabel = "mb-1 block text-[11px] text-ink-faint";
const hint = "mt-1 text-[10.5px] leading-relaxed text-ink-faint";

/** 分段控件（当前值一眼可见，比下拉直观） */
function Segmented<T extends string>({
	value,
	options,
	onChange,
	disabledOptions,
}: {
	value: T;
	options: { value: T; label: string; disabled?: boolean }[];
	onChange: (value: T) => void;
	disabledOptions?: string;
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
			{disabledOptions && <span className="self-center text-[10.5px] text-ink-faint">{disabledOptions}</span>}
		</div>
	);
}

/** 新增 / 编辑 server 的 popover（设计稿决策点 2）。`server` 为空即新增 */
export function ServerEditor({
	server,
	cwd,
	projectTrusted,
	onClose,
}: {
	server?: McpServerView;
	cwd?: string;
	projectTrusted: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const { upsert } = useMcpStore();
	const [form, setForm] = useState<FormState>(() => formOf(server));
	const [moreOpen, setMoreOpen] = useState(MORE_EXPOSURES.includes(formOf(server).exposure));
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const absolutePathHint =
		form.transport === "command" && form.command.length > 0 && !form.command.startsWith("/");

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
			const input: McpUpsertInput = {
				scope: form.scope,
				cwd,
				name: server ? server.name : form.name.trim(),
				command: form.transport === "command" ? form.command.trim() : undefined,
				args: form.transport === "command" && form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
				url: form.transport === "url" ? form.url.trim() : undefined,
				description: form.description,
				exposure: form.exposure,
			};
			await upsert(input);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const exposures = moreOpen ? [...PRIMARY_EXPOSURES, ...MORE_EXPOSURES] : PRIMARY_EXPOSURES;

	return (
		<div className="absolute right-6 top-12 z-10 flex max-h-[min(560px,58vh)] w-[344px] flex-col rounded-[14px] bg-surface shadow-pop">
			<h4 className="shrink-0 px-3.5 pb-2.5 pt-3 text-[12.5px] text-ink-2">
				{server ? t("settings.mcp.editServer") : t("settings.mcp.addServer")}
			</h4>
			{/* 字段区自己滚，操作条常显（保存不需要滚到底） */}
			<div className="min-h-0 flex-1 overflow-y-auto px-3.5">
				<div className="mb-2.5">
					<label className={subLabel} htmlFor="mcp-name">
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
				<div className="mb-2.5">
					{/* 写入位置 + 传输方式并排（省高度）；命令/参数这类长字段仍占满宽 */}
					<div className="grid grid-cols-2 gap-2">
						<div>
							<span className={subLabel}>{t("settings.mcp.scope")}</span>
							<Segmented
								value={form.scope}
								options={[
									{ value: "user", label: t("settings.mcp.scopeGlobal") },
									{
										value: "project",
										label: t("settings.mcp.scopeProject"),
										disabled: !cwd || !projectTrusted,
									},
								]}
								onChange={(scope) => {
									setForm({ ...form, scope });
									setError(null);
								}}
								// 未受信 / 没有活跃项目时禁用项目级（写盘会被后端拒）
								disabledOptions={
									!cwd
										? t("settings.mcp.projectNeedsCwd")
										: !projectTrusted
											? t("settings.mcp.projectUntrusted")
											: undefined
								}
							/>
						</div>
						<div>
							<span className={subLabel}>{t("settings.mcp.transport")}</span>
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
							<div className="mb-2.5">
								<label className={subLabel} htmlFor="mcp-command">
									{t("settings.mcp.command")}
								</label>
								<input
									id="mcp-command"
									className={`${monoInput} ${absolutePathHint ? "border-err" : ""}`}
									value={form.command}
									placeholder="/opt/homebrew/bin/npx"
									onChange={(event) => setForm({ ...form, command: event.target.value })}
								/>
								{absolutePathHint && (
									<p className={`${hint} text-err`}>{t("settings.mcp.absolutePathHint")}</p>
								)}
							</div>
							<div className="mb-2.5">
								<label className={subLabel} htmlFor="mcp-args">
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
						<div className="mb-2.5">
							<label className={subLabel} htmlFor="mcp-url">
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
					<div className="mb-2.5">
						<label className={subLabel} htmlFor="mcp-desc">
							{t("settings.mcp.description")}
						</label>
						<input
							id="mcp-desc"
							className={input}
							value={form.description}
							onChange={(event) => setForm({ ...form, description: event.target.value })}
						/>
					</div>
					<div className="mb-2.5">
						<span className={subLabel}>{t("settings.mcp.exposure")}</span>
						<Segmented
							value={form.exposure as McpExposure | "more"}
							options={[
								...exposures.map((exposure) => ({
									value: exposure as McpExposure | "more",
									label: t(`settings.mcp.exposureShort.${exposure}`),
								})),
								...(moreOpen
									? []
									: [{ value: "more" as McpExposure | "more", label: t("settings.mcp.more") }]),
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
					{error && <p className="mb-2 text-[11px] text-err">{error}</p>}
				</div>
			</div>
			{/* 操作条常显（字段区可滚，保存不需要滚到底） */}
			<div className="flex shrink-0 items-center gap-1.5 px-3.5 pb-3 pt-2.5">
				<span className="flex-1" />
				<button
					type="button"
					className="rounded-full px-2.5 py-1 text-[11px] text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					onClick={onClose}
				>
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

/** 「粘贴 JSON 配置」入口（设计稿决策点 8）：解析成一条/多条 → 打开编辑器预填第一条 */
export function PasteJsonPopover({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
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
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="absolute right-6 top-12 z-10 max-h-[calc(100%-72px)] w-[420px] overflow-y-auto rounded-[14px] bg-surface px-3.5 py-3 shadow-pop">
			<h4 className="mb-2.5 text-[12.5px] text-ink-2">{t("settings.mcp.pasteJsonTitle")}</h4>
			<textarea
				className={`${monoInput} h-[132px] resize-none`}
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
			{error && <p className="mt-1.5 text-[11px] text-err">{error}</p>}
			<div className="mt-2 flex items-center gap-1.5">
				<span className="flex-1" />
				<button
					type="button"
					className="rounded-full px-2.5 py-1 text-[11px] text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					onClick={onClose}
				>
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
