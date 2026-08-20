/** pi.dev 社区包目录（packages 页）跨进程类型 */

/** npm 不在 PATH 上的错误哨兵（backend 抛出、renderer 映射为 i18n 文案；IPC 只保留 message，故放 message 前缀） */
export const NPM_NOT_FOUND_SENTINEL = "PERCHO_NPM_NOT_FOUND";

export type CatalogPackageType = "extension" | "skill" | "prompt" | "theme";

/** 目录中的一个包（从 pi.dev/packages SSR HTML 解析，非官方 JSON API） */
export interface CatalogPackage {
	name: string;
	description: string;
	author: string;
	/** data-package-types 空格分隔；无标记时为 ["package"] */
	types: string[];
	/** 月下载量 */
	downloads: number;
	/** 更新时间（ms epoch） */
	updatedAt: number;
	/** 安装源（npm:<name>，对应 pi install npm:<name>） */
	installSource: string;
}

/** 启发式识别提供 subagent 能力的社区包（安装提醒，不作为安全边界）。 */
export function isSubagentPackage(pkg: Pick<CatalogPackage, "name" | "description">): boolean {
	return /sub-?agent/i.test(`${pkg.name} ${pkg.description}`);
}

export interface CatalogSearchResult {
	packages: CatalogPackage[];
	/** 全量匹配总数（分页用） */
	total: number;
	page: number;
	pageSize: number;
}

/** 已配置的包（settings.json 里的安装记录，用于「已安装」态匹配） */
export interface ConfiguredPackageInfo {
	source: string;
	scope: "user" | "project";
}
