import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
	CatalogPackageType,
	CatalogSearchResult,
	ConfiguredPackageInfo,
	PackageUpdateInfo,
} from "@percho/shared";
import { NPM_NOT_FOUND_SENTINEL, npmSourceToPackageName } from "@percho/shared";
import { createLogger } from "../log";
import { fetchPackageCatalog } from "./catalog";

const log = createLogger("backend");

/** 整轮 registry 查询共用时间预算，避免包数量放大离线等待。 */
const UPDATE_CHECK_TIMEOUT_MS = 8_000;
const UPDATE_CHECK_CONCURRENCY = 4;
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

export { NPM_NOT_FOUND_SENTINEL };

export interface PackageContext {
	cwd: string;
	projectTrusted: boolean;
}

/** 判断错误是否为 spawn npm ENOENT（GUI 启动 PATH 不含 npm 安装目录时的典型报错，issue #18） */
export function isNpmSpawnEnoent(err: unknown): boolean {
	if (
		/(^|\b)spawn(\s+[^\s]+)*\s+npm(\.\w+)?\s+ENOENT\b/.test(err instanceof Error ? err.message : String(err))
	) {
		return true;
	}
	const code = (err as { code?: unknown } | null)?.code;
	const syscall = (err as { syscall?: unknown } | null)?.syscall;
	return code === "ENOENT" && typeof syscall === "string" && /\bnpm\b/.test(syscall);
}

/** npm ENOENT 时换为带哨兵的可读错误，其余原样抛出 */
function rethrowPackageError(err: unknown): never {
	if (isNpmSpawnEnoent(err)) {
		throw new Error(
			`${NPM_NOT_FOUND_SENTINEL}: npm executable not found on PATH (install Node.js, then restart the app)`,
		);
	}
	throw err;
}

/**
 * pi.dev 社区包管理：目录搜索 + 用户级安装/卸载 + 已配置清单。
 * 装/卸后委托空闲会话热重载；忙碌者跳过，不排队补重载（对齐 CLI /reload）。
 */
export class PackageAdmin {
	constructor(
		private readonly deps: {
			reloadIdleSessions: (cwd?: string) => Promise<unknown>;
			defaultCwd?: string;
		},
	) {}

	/** 每次读取新的设置快照；项目上下文由已登记会话提供，不从启动目录猜测。 */
	private getPackageManager(context?: PackageContext): DefaultPackageManager {
		const cwd = context?.cwd ?? this.deps.defaultCwd ?? process.cwd();
		const settingsManager = SettingsManager.create(cwd, getAgentDir(), {
			projectTrusted: context?.projectTrusted ?? false,
		});
		const [failure] = settingsManager.drainErrors();
		if (failure) throw failure.error;
		return new DefaultPackageManager({
			cwd,
			agentDir: getAgentDir(),
			settingsManager,
			// 已注册的内置扩展名（1.0.4）：包解析时能把 `+builtin:tool-search` 这类条目认成已知内置；
			// 未知的 builtin:<name>（如未接的 llama.cpp）只降级为 info 说明，不阻塞（见 getLoadedResources）
			builtinExtensions: ["codemode", "tool-search", "mcp"],
		});
	}

	/** 搜索 pi.dev 社区包目录（设置页扩展面板浏览用） */
	async searchPackages(
		query: string,
		type?: CatalogPackageType | "",
		page?: number,
	): Promise<CatalogSearchResult> {
		return fetchPackageCatalog({ query, type: type || undefined, page });
	}

	/** 列出 settings.json 已配置的包（「已安装」态匹配用） */
	async listConfiguredPackages(context?: PackageContext): Promise<ConfiguredPackageInfo[]> {
		return Promise.all(
			this.getPackageManager(context)
				.listConfiguredPackages()
				.map(async (p) => ({
					source: p.source,
					scope: p.scope,
					installedVersion: npmSourceToPackageName(p.source)
						? await this.readInstalledVersion(p.installedPath)
						: undefined,
				})),
		);
	}

	/** 安装社区包（npm:<name>，用户级）；成功后委托空闲会话重载。 */
	async installPackage(name: string): Promise<void> {
		if (!PACKAGE_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid package name: ${name}`);
		}
		try {
			await this.getPackageManager().installAndPersist(`npm:${name}`);
		} catch (err) {
			rethrowPackageError(err);
		}
		log.info("package installed", name);
		await this.deps.reloadIdleSessions();
	}

	/** 卸载已配置的包（按 source + scope 移除并持久化）；成功后委托空闲会话重载。 */
	async removePackage(source: string, scope: "user" | "project", context?: PackageContext): Promise<void> {
		if (scope === "project" && !context) throw new Error("Project package removal requires a session");
		let removed: boolean;
		try {
			removed = await this.getPackageManager(context).removeAndPersist(source, {
				local: scope === "project",
			});
		} catch (err) {
			rethrowPackageError(err);
		}
		if (!removed) throw new Error(`Package not installed: ${source}`);
		log.info("package removed", source, { scope });
		await this.deps.reloadIdleSessions(scope === "project" ? context?.cwd : undefined);
	}

	/** 复用 SDK 的路径解析，覆盖项目安装和旧全局安装目录。 */
	private async readInstalledVersion(installedPath: string | undefined): Promise<string | undefined> {
		if (!installedPath) return undefined;
		try {
			const raw = await readFile(join(installedPath, "package.json"), "utf8");
			const version = (JSON.parse(raw) as { version?: unknown }).version;
			return typeof version === "string" ? version : undefined;
		} catch {
			return undefined;
		}
	}

	/** registry 上的 latest 版本；失败/超时返回 undefined（不抛，避免一个包拖垮整表） */
	private async fetchLatestVersion(name: string, signal: AbortSignal): Promise<string | undefined> {
		try {
			const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
				signal,
			});
			if (!res.ok) return undefined;
			const version = ((await res.json()) as { version?: unknown }).version;
			return typeof version === "string" ? version : undefined;
		} catch {
			return undefined;
		}
	}

	/** 检查已配置扩展的可用更新（只读：不安装、不重载） */
	async checkPackageUpdates(packageNames: string[]): Promise<PackageUpdateInfo[]> {
		const names = [...new Set(packageNames)];
		if (names.some((name) => !PACKAGE_NAME_PATTERN.test(name))) {
			throw new Error("Invalid package name");
		}
		const latestByName = new Map<string, string | undefined>();
		const signal = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(UPDATE_CHECK_CONCURRENCY, names.length) }, async () => {
				while (next < names.length && !signal.aborted) {
					const name = names[next++];
					if (name) latestByName.set(name, await this.fetchLatestVersion(name, signal));
				}
			}),
		);
		return names.map((name) => ({ name, latest: latestByName.get(name) ?? "" }));
	}
}
