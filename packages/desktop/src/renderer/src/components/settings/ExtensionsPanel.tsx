import type { CatalogPackage, CatalogPackageType, LoadedExtension, ResourceScope } from "@pi-desktop/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { CheckIcon, SearchIcon, TrashIcon } from "../icons";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";

const CATALOG_TYPES: ("" | CatalogPackageType)[] = ["", "extension", "skill", "prompt", "theme"];

/** 下载量格式化：479565 → 479.6K，1234567 → 1.2M */
function formatDownloads(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** 已配置 source → 包名（仅 npm: 源能与目录匹配；剥版本后缀，兼容 scoped 名） */
function npmSourceToName(source: string): string | null {
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
	const removing = useSettingsStore((s) => s.removingSources[source] === true);
	const removeConfiguredPackage = useSettingsStore((s) => s.removeConfiguredPackage);

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

function ExtensionRow({
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

function CatalogRow({
	pkg,
	configured,
}: {
	pkg: CatalogPackage;
	configured: { source: string; scope: "user" | "project" } | null;
}) {
	const t = useT();
	const installing = useSettingsStore((s) => s.installingNames[pkg.name] === true);
	const installError = useSettingsStore((s) => s.installErrors[pkg.name]);
	const installCatalogPackage = useSettingsStore((s) => s.installCatalogPackage);

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
				{installError && <p className="mt-1 text-[11px] text-red-500">{installError}</p>}
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
					<Button
						variant="primary"
						size="sm"
						disabled={installing}
						onClick={() => void installCatalogPackage(pkg.name)}
					>
						{installing ? (
							<span className="inline-flex items-center gap-1.5">
								<span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
								{t("settings.extensions.installing")}
							</span>
						) : (
							t("settings.extensions.install")
						)}
					</Button>
				)}
			</div>
		</li>
	);
}

/** 浏览社区：pi.dev 目录搜索 + 安装 */
function BrowseSection() {
	const t = useT();
	const query = useSettingsStore((s) => s.catalogQuery);
	const type = useSettingsStore((s) => s.catalogType);
	const packages = useSettingsStore((s) => s.catalogPackages);
	const total = useSettingsStore((s) => s.catalogTotal);
	const loading = useSettingsStore((s) => s.catalogLoading);
	const loadingMore = useSettingsStore((s) => s.catalogLoadingMore);
	const error = useSettingsStore((s) => s.catalogError);
	const configuredPackages = useSettingsStore((s) => s.configuredPackages);
	const setCatalogQuery = useSettingsStore((s) => s.setCatalogQuery);
	const setCatalogType = useSettingsStore((s) => s.setCatalogType);
	const searchCatalog = useSettingsStore((s) => s.searchCatalog);

	// name → 已配置条目（「已安装」态 + 卸载入口；只有 npm: 源能对上目录包）
	const configuredByPackage = useMemo(() => {
		const map = new Map<string, { source: string; scope: "user" | "project" }>();
		for (const p of configuredPackages ?? []) {
			const name = npmSourceToName(p.source);
			if (name && !map.has(name)) map.set(name, { source: p.source, scope: p.scope });
		}
		return map;
	}, [configuredPackages]);

	// 已配置包列表只需拉一次（安装成功后 store 会自刷）；目录首载（防抖搜索只在输入时触发）
	useEffect(() => {
		const s = useSettingsStore.getState();
		if (s.configuredPackages === null) void s.refreshConfiguredPackages();
		if (s.catalogPage === 0 && !s.catalogLoading) void s.searchCatalog(false);
	}, []);

	const remaining = total - packages.length;

	return (
		<div>
			<div className="relative">
				<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
				<input
					className="w-full rounded-lg bg-hover/80 py-2 pl-9 pr-3 text-[13px] outline-none placeholder:text-ink-faint focus:bg-hover"
					placeholder={t("settings.extensions.searchPlaceholder")}
					value={query}
					onChange={(e) => setCatalogQuery(e.target.value)}
				/>
			</div>
			<div className="mt-2 flex flex-wrap gap-1">
				{CATALOG_TYPES.map((id) => (
					<button
						key={id || "all"}
						type="button"
						className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
							type === id ? "bg-ink font-medium text-on-ink" : "bg-hover text-ink-dim hover:text-ink"
						}`}
						onClick={() => setCatalogType(id)}
					>
						{t(`settings.extensions.type.${id || "all"}`)}
					</button>
				))}
			</div>
			{loading ? (
				<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.extensions.loading")}</p>
			) : error ? (
				<div className="py-8 text-center">
					<p className="text-[13px] text-ink-faint">{t("settings.extensions.catalogError")}</p>
					<p className="mt-1 text-[11px] text-ink-faint">{error}</p>
					<Button size="sm" className="mt-3" onClick={() => void searchCatalog(false)}>
						{t("settings.extensions.retry")}
					</Button>
				</div>
			) : packages.length === 0 ? (
				<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.extensions.noResults")}</p>
			) : (
				<>
					<ul className="mt-1 divide-y divide-border">
						{packages.map((pkg) => (
							<CatalogRow key={pkg.name} pkg={pkg} configured={configuredByPackage.get(pkg.name) ?? null} />
						))}
					</ul>
					{remaining > 0 && (
						<div className="mt-2 flex justify-center">
							<Button size="sm" disabled={loadingMore} onClick={() => void searchCatalog(true)}>
								{loadingMore ? (
									<span className="inline-flex items-center gap-1.5">
										<span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
										{t("settings.extensions.loading")}
									</span>
								) : (
									t("settings.extensions.loadMore", { count: remaining })
								)}
							</Button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

/** 已加载：当前项目（活跃会话）加载的扩展及其注册的工具/命令 */
function LoadedSection() {
	const t = useT();
	const extensions = useSettingsStore((s) => s.extensions);
	const errors = useSettingsStore((s) => s.extensionErrors);
	const configuredPackages = useSettingsStore((s) => s.configuredPackages);

	// 已加载扩展的 source 命中已配置包 → 可卸载（source 为 npm:/git: 等安装源时）
	const configuredBySource = useMemo(() => {
		const map = new Map<string, { source: string; scope: "user" | "project" }>();
		for (const p of configuredPackages ?? []) {
			if (!map.has(p.source)) map.set(p.source, { source: p.source, scope: p.scope });
		}
		return map;
	}, [configuredPackages]);

	if (extensions === null) {
		return (
			<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.extensions.emptyNoSession")}</p>
		);
	}
	return (
		<div>
			{extensions.length === 0 && errors.length === 0 ? (
				<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.extensions.empty")}</p>
			) : (
				<ul className="divide-y divide-border">
					{extensions.map((extension) => (
						<ExtensionRow
							key={extension.path}
							extension={extension}
							configured={configuredBySource.get(extension.source) ?? null}
						/>
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

/** 扩展设置面板：浏览社区目录安装 + 查看已加载扩展（分段切换） */
export function ExtensionsPanel() {
	const t = useT();
	const tab = useSettingsStore((s) => s.extensionsTab);
	const setExtensionsTab = useSettingsStore((s) => s.setExtensionsTab);

	return (
		<div>
			<h3 className="text-[13px] font-medium text-ink">{t("settings.extensions.title")}</h3>
			<p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.extensions.hint")}</p>
			<div className="mt-3 flex rounded-lg bg-hover p-0.5">
				{(["browse", "loaded"] as const).map((id) => (
					<button
						key={id}
						type="button"
						className={`flex-1 rounded-md px-3 py-1 text-[12px] transition-colors ${
							tab === id ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-dim hover:text-ink"
						}`}
						onClick={() => setExtensionsTab(id)}
					>
						{t(`settings.extensions.tab.${id}`)}
					</button>
				))}
			</div>
			<div className="mt-3">{tab === "browse" ? <BrowseSection /> : <LoadedSection />}</div>
		</div>
	);
}
