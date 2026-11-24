import gt from "semver/functions/gt.js";
import valid from "semver/functions/valid.js";

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
	/** SDK 实际安装路径中的版本；无需联网，未安装或无法读取时省略。 */
	installedVersion?: string;
}

/** 同一安装源可以同时存在于用户与项目范围。 */
export function configuredPackageKey(pkg: { source: string; scope: string }): string {
	return `${pkg.scope}:${pkg.source}`;
}

/** npm 版本查询结果；与项目、安装范围及本地安装版本无关。 */
export interface PackageUpdateInfo {
	name: string;
	/** registry 上的 latest；查不到时为空串 */
	latest: string;
}

/**
 * 单包原地更新的结果。
 * - `from`/`to`：更新前后版本；`to === from` 表示版本未变（已是最新或 registry 不可达）。
 * - `deferred`：因正在运行而未重载的会话数，它们结束后才会加载新版本。
 */
export interface PackageUpdateResult {
	from?: string;
	to?: string;
	deferred?: number;
}

export function isNewerVersion(latest: string, installed: string): boolean {
	return Boolean(valid(latest) && valid(installed) && gt(latest, installed));
}

/** npm: 源 → 包名（剥版本后缀，兼容 @scope/name） */
export function npmSourceToPackageName(source: string): string | null {
	if (!source.startsWith("npm:")) return null;
	const spec = source.slice(4);
	const searchFrom = spec.startsWith("@") ? spec.indexOf("/") + 1 : 1;
	const at = spec.indexOf("@", searchFrom);
	return at > 0 ? spec.slice(0, at) : spec;
}

/** 允许原地更新的来源：npm 包且未锁定精确版本（与 SDK 一致：`npm:x@1.2.3` 视为固定，范围仍可更新） */
export function isUpdatableSource(source: string): boolean {
	const name = npmSourceToPackageName(source);
	if (!name) return false;
	const version = source.slice(4 + name.length + 1);
	return !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
