import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
	CatalogPackageType,
	CatalogSearchResult,
	ConfiguredPackageInfo,
	PackageUpdateInfo,
} from "@percho/shared";
import { isNewerVersion, NPM_NOT_FOUND_SENTINEL, npmSourceToPackageName } from "@percho/shared";
import { createLogger } from "../log";
import { fetchPackageCatalog } from "./catalog";

const log = createLogger("backend");

/** registry 查询超时：单个包卡住不能拖垮整张表 */
const UPDATE_CHECK_TIMEOUT_MS = 8_000;

export { NPM_NOT_FOUND_SENTINEL };

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
	private packageManager: DefaultPackageManager | undefined;

	constructor(
		private readonly deps: {
			reloadIdleSessions: () => Promise<unknown>;
			defaultCwd?: string;
		},
	) {}

	/** 包管理器（用户级安装/卸载，懒加载；settingsManager 仅用于读写 settings.json 安装记录） */
	private getPackageManager(): DefaultPackageManager {
		if (!this.packageManager) {
			const cwd = this.deps.defaultCwd || process.cwd();
			this.packageManager = new DefaultPackageManager({
				cwd,
				agentDir: getAgentDir(),
				settingsManager: SettingsManager.create(cwd, getAgentDir()),
				// 已注册的内置扩展名（1.0.4）：包解析时能把 `+builtin:tool-search` 这类条目认成已知内置；
				// 未知的 builtin:<name>（如未接的 llama.cpp）只降级为 info 说明，不阻塞（见 getLoadedResources）
				builtinExtensions: ["codemode", "tool-search", "mcp"],
			});
		}
		return this.packageManager;
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
	async listConfiguredPackages(): Promise<ConfiguredPackageInfo[]> {
		return this.getPackageManager()
			.listConfiguredPackages()
			.map((p) => ({ source: p.source, scope: p.scope }));
	}

	/** 安装社区包（npm:<name>，用户级）；成功后委托空闲会话重载。 */
	async installPackage(name: string): Promise<void> {
		if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
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
	async removePackage(source: string, scope: "user" | "project"): Promise<void> {
		let removed: boolean;
		try {
			removed = await this.getPackageManager().removeAndPersist(source, {
				local: scope === "project",
			});
		} catch (err) {
			rethrowPackageError(err);
		}
		if (!removed) throw new Error(`Package not installed: ${source}`);
		log.info("package removed", source, { scope });
		await this.deps.reloadIdleSessions();
	}

	/** 本地已装版本（读 agentDir/npm/node_modules/<name>/package.json）；读不到返回 undefined */
	private async readInstalledVersion(name: string): Promise<string | undefined> {
		try {
			const raw = await readFile(join(getAgentDir(), "npm", "node_modules", name, "package.json"), "utf8");
			const version = (JSON.parse(raw) as { version?: unknown }).version;
			return typeof version === "string" ? version : undefined;
		} catch {
			return undefined;
		}
	}

	/** registry 上的 latest 版本；失败/超时返回 undefined（不抛，避免一个包拖垮整表） */
	private async fetchLatestVersion(name: string): Promise<string | undefined> {
		try {
			const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
				signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
			});
			if (!res.ok) return undefined;
			const version = ((await res.json()) as { version?: unknown }).version;
			return typeof version === "string" ? version : undefined;
		} catch {
			return undefined;
		}
	}

	/** 检查已配置扩展的可用更新（只读：不安装、不重载） */
	async checkPackageUpdates(): Promise<PackageUpdateInfo[]> {
		const seen = new Map<string, string>();
		for (const p of await this.listConfiguredPackages()) {
			const name = npmSourceToPackageName(p.source);
			if (name && !seen.has(name)) seen.set(name, p.source);
		}
		return Promise.all(
			[...seen].map(async ([name, source]) => {
				const [installed, latest] = await Promise.all([
					this.readInstalledVersion(name),
					this.fetchLatestVersion(name),
				]);
				return {
					name,
					source,
					installed: installed ?? "",
					latest: latest ?? "",
					hasUpdate: Boolean(installed && latest && isNewerVersion(latest, installed)),
				};
			}),
		);
	}
}
