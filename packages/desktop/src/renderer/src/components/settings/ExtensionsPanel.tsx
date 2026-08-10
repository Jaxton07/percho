import type { LoadedExtension, ResourceScope } from "@pi-desktop/shared";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";

/** 来源作用域 badge：用户级中性色，项目级 accent 系，临时合成最弱 */
function ScopeBadge({ scope }: { scope: ResourceScope }) {
	const t = useT();
	const key =
		scope === "project"
			? "settings.extensions.scopeProject"
			: scope === "temporary"
				? "settings.extensions.scopeTemporary"
				: "settings.extensions.scopeUser";
	return (
		<span
			className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
				scope === "project" ? "bg-accent/10 text-accent" : "bg-hover text-ink-2"
			}`}
		>
			{t(key)}
		</span>
	);
}

function Stat({ label }: { label: string }) {
	return <span className="text-[10px] text-ink-faint">{label}</span>;
}

function ExtensionRow({ extension }: { extension: LoadedExtension }) {
	const t = useT();
	return (
		<li className="py-2.5">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{extension.name}</span>
				{extension.hidden && (
					<span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-faint">
						{t("settings.extensions.hidden")}
					</span>
				)}
				<ScopeBadge scope={extension.scope} />
			</div>
			<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
				{extension.toolsCount > 0 && (
					<Stat label={t("settings.extensions.tools", { count: extension.toolsCount })} />
				)}
				{extension.commands.length > 0 && (
					<Stat label={t("settings.extensions.commands", { count: extension.commands.length })} />
				)}
				{extension.flagsCount > 0 && (
					<Stat label={t("settings.extensions.flags", { count: extension.flagsCount })} />
				)}
				{extension.shortcutsCount > 0 && (
					<Stat label={t("settings.extensions.shortcuts", { count: extension.shortcutsCount })} />
				)}
			</div>
			<p className="mt-1 truncate font-mono text-[10px] text-ink-faint">{extension.path}</p>
		</li>
	);
}

/** 扩展设置面板：展示当前项目（活跃会话）已加载的扩展及其注册的工具/命令 */
export function ExtensionsPanel() {
	const t = useT();
	const extensions = useSettingsStore((s) => s.extensions);
	const errors = useSettingsStore((s) => s.extensionErrors);

	if (extensions === null) {
		return (
			<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.extensions.emptyNoSession")}</p>
		);
	}
	return (
		<div>
			<h3 className="text-[13px] font-medium text-ink">{t("settings.extensions.title")}</h3>
			<p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.extensions.hint")}</p>
			{extensions.length === 0 && errors.length === 0 ? (
				<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.extensions.empty")}</p>
			) : (
				<ul className="mt-3 divide-y divide-border">
					{extensions.map((extension) => (
						<ExtensionRow key={extension.path} extension={extension} />
					))}
				</ul>
			)}
			{errors.length > 0 && (
				<div className="mt-4 rounded-lg bg-red-50 px-3 py-2">
					<p className="text-[11px] font-medium text-red-600">
						{t("settings.extensions.loadErrors", { count: errors.length })}
					</p>
					<ul className="mt-1 space-y-1">
						{errors.map((err) => (
							<li key={err.path} className="text-[11px] leading-relaxed text-red-500">
								<span className="font-mono">{err.path}</span> — {err.error}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
