import type { CatalogPackage, LoadedExtension, ResourceScope } from "@percho/shared";
import { isSubagentPackage, isSubagentToolName, NPM_NOT_FOUND_SENTINEL } from "@percho/shared";
import { useRef, useState } from "react";
import { useT } from "../../../i18n";
import { useCatalogStore } from "../../../stores/catalog";
import { CheckIcon, TrashIcon } from "../../icons";
import { Button } from "../../ui/Button";
import { Tooltip } from "../../ui/Tooltip";

/** 下载量格式化：479565 → 479.6K，1234567 → 1.2M */
export function formatDownloads(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** 已配置 source → 包名（仅 npm: 源能与目录匹配；剥版本后缀，兼容 scoped 名） */
export function npmSourceToName(source: string): string | null {
	if (!source.startsWith("npm:")) return null;
	const spec = source.slice(4);
	const searchFrom = spec.startsWith("@") ? spec.indexOf("/") + 1 : 1;
	const at = spec.indexOf("@", searchFrom);
	return at > 0 ? spec.slice(0, at) : spec;
}

/** 卸载按钮：点击进入确认态（红字，再点执行）；鼠标移出或 3s 后自动恢复 */
function UninstallButton({ source, scope }: { source: string; scope: "user" | "project" }) {
	const t = useT();
	const [confirming, setConfirming] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const removing = useCatalogStore((s) => s.removingSources[source] === true);
	const removeConfiguredPackage = useCatalogStore((s) => s.removeConfiguredPackage);

	const enterConfirm = () => {
		setConfirming(true);
		clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setConfirming(false), 3000);
	};

	if (confirming) {
		return (
			<button
				type="button"
				className="rounded-lg px-2 py-1 text-[12px] font-medium text-red-500 transition-colors hover:text-red-600 disabled:opacity-40"
				disabled={removing}
				onClick={() => void removeConfiguredPackage(source, scope)}
				onMouseLeave={() => setConfirming(false)}
			>
				{removing ? (
					<span className="inline-flex items-center gap-1.5">
						<span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
						{t("settings.extensions.removing")}
					</span>
				) : (
					t("settings.extensions.confirmUninstall")
				)}
			</button>
		);
	}
	return (
		<Tooltip label={t("settings.extensions.uninstall")}>
			<button
				type="button"
				className="rounded-lg px-1.5 py-1 text-ink-faint transition-colors hover:bg-hover hover:text-red-500"
				onClick={enterConfirm}
				aria-label={t("settings.extensions.uninstall")}
			>
				<TrashIcon size={13} />
			</button>
		</Tooltip>
	);
}

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

export function ExtensionRow({
	extension,
	configured,
}: {
	extension: LoadedExtension;
	configured: { source: string; scope: "user" | "project" } | null;
}) {
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
				{extension.tools.some(isSubagentToolName) && (
					<span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
						{t("settings.extensions.subagentBuiltin")}
					</span>
				)}
				<ScopeBadge scope={extension.scope} />
				{configured && <UninstallButton source={configured.source} scope={configured.scope} />}
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

/** 类型 badge：extension 用 accent 系（本面板主角），其余中性色 */
function TypeBadge({ type }: { type: string }) {
	return (
		<span
			className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
				type === "extension" ? "bg-accent/10 text-accent" : "bg-hover text-ink-2"
			}`}
		>
			{type}
		</span>
	);
}

export function CatalogRow({
	pkg,
	configured,
}: {
	pkg: CatalogPackage;
	configured: { source: string; scope: "user" | "project" } | null;
}) {
	const t = useT();
	const installing = useCatalogStore((s) => s.installingNames[pkg.name] === true);
	const installError = useCatalogStore((s) => s.installErrors[pkg.name]);
	const installCatalogPackage = useCatalogStore((s) => s.installCatalogPackage);
	// subagent 包安装前警示：两段式确认（与 UninstallButton 同模式，不用 window.confirm）
	const [warnConfirming, setWarnConfirming] = useState(false);
	const warnTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const isSubagent = isSubagentPackage(pkg);
	const handleInstall = () => {
		if (isSubagent && !warnConfirming) {
			setWarnConfirming(true);
			clearTimeout(warnTimerRef.current);
			warnTimerRef.current = setTimeout(() => setWarnConfirming(false), 3000);
			return;
		}
		setWarnConfirming(false);
		void installCatalogPackage(pkg.name);
	};

	return (
		<li className="flex items-start gap-3 py-2.5">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="min-w-0 truncate text-[13px] font-medium text-ink">{pkg.name}</span>
					{pkg.types.map((type) => (
						<TypeBadge key={type} type={type} />
					))}
				</div>
				{pkg.description && (
					<p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-ink-dim">{pkg.description}</p>
				)}
				<div className="mt-1 flex items-center gap-2 text-[10px] text-ink-faint">
					{pkg.author && <span>{pkg.author}</span>}
					{pkg.author && <span aria-hidden>·</span>}
					<span>{t("settings.extensions.downloadsPerMonth", { count: formatDownloads(pkg.downloads) })}</span>
				</div>
				{installError && (
					<p className="mt-1 text-[11px] text-red-500">
						{installError.includes(NPM_NOT_FOUND_SENTINEL)
							? t("settings.extensions.npmNotFound")
							: installError}
					</p>
				)}
			</div>
			<div className="shrink-0 pt-0.5">
				{configured ? (
					<div className="flex items-center gap-0.5">
						<span className="inline-flex items-center gap-1 px-1.5 py-1 text-[12px] text-ink-faint">
							<CheckIcon size={11} />
							{t("settings.extensions.installed")}
						</span>
						<UninstallButton source={configured.source} scope={configured.scope} />
					</div>
				) : (
					<div className="flex flex-col items-end gap-1">
						<Button
							variant="primary"
							size="sm"
							disabled={installing}
							title={isSubagent ? t("settings.extensions.subagentInstallWarning") : undefined}
							onClick={handleInstall}
						>
							{installing ? (
								<span className="inline-flex items-center gap-1.5">
									<span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
									{t("settings.extensions.installing")}
								</span>
							) : warnConfirming ? (
								t("settings.extensions.subagentInstallConfirm")
							) : (
								t("settings.extensions.install")
							)}
						</Button>
						{warnConfirming && (
							<p className="max-w-56 text-right text-[11px] leading-snug text-ink-dim">
								{t("settings.extensions.subagentInstallWarning")}
							</p>
						)}
					</div>
				)}
			</div>
		</li>
	);
}
