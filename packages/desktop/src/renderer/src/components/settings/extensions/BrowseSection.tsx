import type { CatalogPackageType } from "@percho/shared";
import { useEffect, useMemo } from "react";
import { useT } from "../../../i18n";
import { useCatalogStore } from "../../../stores/catalog";
import { SearchIcon } from "../../icons";
import { Button } from "../../ui/Button";
import { CatalogRow, npmSourceToName } from "./rows";

const CATALOG_TYPES: ("" | CatalogPackageType)[] = ["", "extension", "skill", "prompt", "theme"];

/** 浏览社区：pi.dev 目录搜索 + 安装 */
export function BrowseSection() {
	const t = useT();
	const query = useCatalogStore((s) => s.catalogQuery);
	const type = useCatalogStore((s) => s.catalogType);
	const packages = useCatalogStore((s) => s.catalogPackages);
	const total = useCatalogStore((s) => s.catalogTotal);
	const loading = useCatalogStore((s) => s.catalogLoading);
	const loadingMore = useCatalogStore((s) => s.catalogLoadingMore);
	const error = useCatalogStore((s) => s.catalogError);
	const configuredPackages = useCatalogStore((s) => s.configuredPackages);
	const setCatalogQuery = useCatalogStore((s) => s.setCatalogQuery);
	const setCatalogType = useCatalogStore((s) => s.setCatalogType);
	const searchCatalog = useCatalogStore((s) => s.searchCatalog);

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
		const s = useCatalogStore.getState();
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
