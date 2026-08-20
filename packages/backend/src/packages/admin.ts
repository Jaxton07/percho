import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CatalogPackageType, CatalogSearchResult, ConfiguredPackageInfo } from "@percho/shared";
import { NPM_NOT_FOUND_SENTINEL } from "@percho/shared";
import { createLogger } from "../log";
import type { SessionRegistry } from "../session/registry";
import { fetchPackageCatalog } from "./catalog";

const log = createLogger("backend");

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
 * 装/卸后对非流式活跃会话热重载，扩展立即生效（对齐 CLI /reload）。
 */
export class PackageAdmin {
	private packageManager: DefaultPackageManager | undefined;

	constructor(
		private readonly deps: {
			registry: SessionRegistry;
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

	/** 安装社区包（npm:<name>，用户级）；成功后热重载非流式活跃会话，扩展立即生效 */
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
		await this.reloadSessions();
	}

	/** 卸载已配置的包（按 source + scope 移除并持久化）；成功后热重载非流式活跃会话 */
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
		await this.reloadSessions();
	}

	/** 对非流式活跃会话做资源热重载（装/卸包后立即生效） */
	private async reloadSessions(): Promise<void> {
		for (const entry of this.deps.registry.list()) {
			if (entry.session.isStreaming) {
				log.info("skip reload while streaming", entry.session.sessionId);
				continue;
			}
			try {
				await entry.session.reload();
			} catch (err) {
				log.warn("session reload failed", entry.session.sessionId, err);
			}
		}
	}
}
