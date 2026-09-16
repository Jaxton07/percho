import { existsSync, type FSWatcher, watch } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@percho/backend";
import type { UiPluginInfo, UiPluginManifest, UiPluginsConfig } from "@percho/shared";
import { app } from "electron";
import { buildPlugin } from "./build";
import { defaultUiPluginsConfig, loadUiPluginsConfig, saveUiPluginsConfig } from "./config";

const log = createLogger("ui-plugins");

import { newestMtime } from "./fs-tree";
import { filterContributions, NAME_RE, readManifest, validateManifest } from "./manifest";
import { builtinPluginsDir, pluginsDir, seedBuiltinPlugins, seedDocs } from "./seeder";

/** manifest 读取 + 校验 + contributions 过滤（manifest.ts）；资源目录等路径原语见 seeder.ts */
export { filterContributions } from "./manifest";
export { uiPluginsResourcesDir } from "./seeder";

export class UiPluginManager {
	/** name → 扫描信息（scanAll 合成；buildError 是内存态，保留在 Map 里跨扫描存活） */
	private infos = new Map<string, UiPluginInfo>();
	/** name → 插件目录绝对路径（白名单：readCode/openDir 只接受扫描到的合法名） */
	private dirNames = new Map<string, string>();
	/** 随包内置插件名集合（init 时导出到用户目录；此处仅用于合成 builtin 标志 → 面板 badge/启用免确认） */
	private builtinNames = new Set<string>();
	/** 持久化配置缓存（updateConfig 后刷新；scanAll 时叠加） */
	private config: UiPluginsConfig = defaultUiPluginsConfig();
	/** 热重载 watcher（startWatcher 启动；will-quit 时关闭） */
	private watchers: FSWatcher[] = [];
	/** 插件名 → 防抖重建定时器（连续保存只重建一次） */
	private rebuildTimers = new Map<string, NodeJS.Timeout>();

	/** 确保插件根目录存在、分发规范文档与内置插件、加载配置 + 首次扫描 */
	async init(): Promise<void> {
		await mkdir(pluginsDir(), { recursive: true });
		// 0.4.0 内置插件版本化缓存目录的遗留（seed 方案后不再需要，静默清掉）
		await rm(join(app.getPath("userData"), "ui-plugins-builtin"), { recursive: true, force: true }).catch(
			() => {},
		);
		await seedDocs();
		await seedBuiltinPlugins();
		await this.scanAll();
	}

	/** 合成单个插件的 UiPluginInfo（统一从用户插件目录扫描；builtin 标志来自随包名单） */
	private async scanOne(name: string, srcDir: string): Promise<UiPluginInfo> {
		const manifest = await readManifest(srcDir);
		const invalidReason = validateManifest(name, manifest ?? {});
		const prev = this.infos.get(name);
		return {
			name,
			displayName: typeof manifest?.displayName === "string" ? manifest.displayName : undefined,
			description: typeof manifest?.description === "string" ? manifest.description : undefined,
			version: typeof manifest?.version === "string" ? manifest.version : undefined,
			perchoUi: manifest?.perchoUi,
			slots: manifest?.slots ?? {},
			contributions: filterContributions(manifest?.contributions),
			headless: manifest?.headless === true ? true : undefined,
			enabled: this.config.plugins[name]?.enabled ?? false,
			trusted: this.config.plugins[name]?.trusted ?? false,
			invalidReason: invalidReason ?? undefined,
			buildError: prev?.buildError,
			built: existsSync(join(srcDir, "dist/index.js")),
			builtin: this.builtinNames.has(name) || undefined, // 用户插件不落字段（保持载荷干净）
		};
	}

	/** 扫描 userData/ui-plugins/ 每个子目录：校验 manifest 并合成 UiPluginInfo（叠加 config/产物状态） */
	async scanAll(): Promise<UiPluginInfo[]> {
		this.config = await loadUiPluginsConfig();
		// 随包内置名单（每次扫描现取，目录静态几乎零开销）
		const builtinEntries = await readdir(builtinPluginsDir(), { withFileTypes: true }).catch(() => []);
		this.builtinNames = new Set(
			builtinEntries.filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name),
		);
		const dir = pluginsDir();
		const out: UiPluginInfo[] = [];
		const seen = new Set<string>();
		const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
			log.error("scanAll readdir failed", err);
			return [];
		});
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const name = entry.name;
			if (!NAME_RE.test(name)) continue; // 目录名非法直接跳过（不占白名单）
			try {
				seen.add(name);
				this.dirNames.set(name, join(dir, name));
				const info = await this.scanOne(name, join(dir, name));
				this.infos.set(name, info);
				out.push(info);
			} catch (err) {
				// 单插件扫描异常不阻断应用启动与其余插件（B2）：合成 invalid info 继续下一个
				const msg = err instanceof Error ? err.message : String(err);
				log.error("scanOne failed", name, err);
				const info: UiPluginInfo = {
					name,
					slots: {},
					contributions: [],
					enabled: false,
					trusted: false,
					built: false,
					invalidReason: `扫描异常: ${msg}`,
				};
				this.infos.set(name, info);
				out.push(info);
			}
		}
		// 清理幽灵条目：目录已删除/改名的插件从两个 Map 移除（否则面板显示已删除插件直到重启）
		for (const stale of [...this.infos.keys()]) {
			if (!seen.has(stale)) this.infos.delete(stale);
		}
		for (const stale of [...this.dirNames.keys()]) {
			if (!seen.has(stale)) this.dirNames.delete(stale);
		}
		return out;
	}

	/** 列表（设置面板/加载器用）：读扫描缓存 */
	list(): UiPluginInfo[] {
		return Array.from(this.infos.values());
	}

	/** 按名取单个插件信息（无效名/未知插件返回 null） */
	info(name: string): UiPluginInfo | null {
		return this.infos.get(name) ?? null;
	}

	/**
	 * 确保插件已构建：dist 缺失或源码比 dist 新 → 构建；force=true 无条件重建。
	 * 失败记 buildError（旧产物保留继续生效）；无效插件/未知名返回 false。
	 */
	async ensureBuilt(name: string, force = false): Promise<boolean> {
		const info = this.infos.get(name);
		if (!info || info.invalidReason) return false;
		const pluginDir = this.dirNames.get(name);
		const manifest = await readManifest(pluginDir ?? "");
		if (!pluginDir || !manifest || typeof manifest.main !== "string") return false;
		const dist = join(pluginDir, "dist/index.js");
		try {
			let needsBuild = force || !existsSync(dist);
			if (!needsBuild) {
				const srcMtime = await newestMtime(pluginDir);
				const distStat = await stat(dist).catch(() => null);
				needsBuild = srcMtime === null || !distStat || srcMtime > distStat.mtimeMs;
			}
			if (needsBuild) {
				const res = await buildPlugin(pluginDir, manifest.main);
				if (res.ok) {
					this.infos.set(name, { ...info, buildError: undefined, built: true });
				} else {
					this.infos.set(name, { ...info, buildError: res.error, built: existsSync(dist) });
				}
				return res.ok;
			}
			return true;
		} catch (err) {
			log.error("ensureBuilt failed", name, err);
			return false;
		}
	}

	/**
	 * 读插件构建产物（白名单：只接受扫描到的合法名；先 ensureBuilt 再读 dist/index.js）。
	 * 返回 { manifest, code } 或 { error }。
	 */
	async readCode(name: string): Promise<{ manifest: UiPluginManifest; code: string } | { error: string }> {
		const info = this.infos.get(name);
		if (!info || info.invalidReason) return { error: `未知插件 ${name}` };
		const pluginDir = this.dirNames.get(name);
		if (!pluginDir) return { error: `未知插件 ${name}` };
		const ok = await this.ensureBuilt(name);
		if (!ok) {
			// 构建失败：旧产物存在则继续生效（spec §6，不清 dist）；buildError 已进 list 由面板展示
			if (!existsSync(join(pluginDir, "dist/index.js"))) {
				return { error: this.infos.get(name)?.buildError ?? `构建失败：${name}` };
			}
		}
		try {
			const [manifest, code] = await Promise.all([
				readManifest(pluginDir),
				readFile(join(pluginDir, "dist/index.js"), "utf-8"),
			]);
			if (!manifest || validateManifest(name, manifest)) return { error: "manifest 校验失败" };
			// 未知 region 条目已被过滤（与 scanAll 合成 info 同源），registry 只注册已知区域
			const cleanManifest: UiPluginManifest = {
				...(manifest as UiPluginManifest),
				contributions: filterContributions(manifest.contributions),
			};
			return { manifest: cleanManifest, code };
		} catch (err) {
			log.error("readCode failed", name, err);
			return { error: String(err) };
		}
	}

	/** 插件目录绝对路径（白名单：只接受扫描到的合法名；无效名返回 null） */
	pluginDirOf(name: string): string | null {
		return this.dirNames.get(name) ?? null;
	}

	/** 插件根目录绝对路径 */
	rootDir(): string {
		return pluginsDir();
	}

	/**
	 * 启动热重载 watcher：监听插件目录（recursive），变更落在某插件的 src/ 或 plugin.json
	 * → 300ms 防抖后重新扫描+构建（无论成败）→ 回调通知（推 { kind: "changed", name }）。
	 * dist/ 下的构建产物事件忽略（否则构建自身会触发重建死循环）；watch 失败只告警不致命。
	 * （内置插件已导出到本目录，天然被覆盖——无需第二路 watcher）
	 */
	startWatcher(onChange: (name: string) => void): void {
		if (this.watchers.length > 0) return;
		try {
			this.watchers.push(
				watch(pluginsDir(), { recursive: true }, (_event, filename) => {
					if (typeof filename !== "string") return;
					const rel = filename.split(/[\\/]/);
					const name = rel[0];
					if (!name || !NAME_RE.test(name)) return;
					const rest = rel.slice(1);
					if (rest.length === 0 || rest[0] === "dist") return; // 目录事件/构建产物忽略
					this.scheduleRebuild(name, onChange);
				}),
			);
		} catch (err) {
			log.error("fs.watch failed（热重载不可用，手动重建不受影响）", err);
		}
	}

	/** 300ms 防抖：连续保存只重建一次；插件已删除则 scanAll 清理后不再通知 */
	private scheduleRebuild(name: string, onChange: (name: string) => void): void {
		clearTimeout(this.rebuildTimers.get(name));
		this.rebuildTimers.set(
			name,
			setTimeout(() => {
				this.rebuildTimers.delete(name);
				void (async () => {
					await this.scanAll(); // 可能插件被删/改名/plugin.json 变更
					if (!this.infos.has(name)) return; // 插件没了：scanAll 已清缓存，无需通知
					await this.ensureBuilt(name); // 失败时 buildError 已更新（旧产物继续生效）
					onChange(name);
				})();
			}, 300),
		);
	}

	/** 关闭 watcher 并清防抖定时器（app will-quit 时调用） */
	disposeWatcher(): void {
		for (const timer of this.rebuildTimers.values()) clearTimeout(timer);
		this.rebuildTimers.clear();
		for (const w of this.watchers) w.close();
		this.watchers = [];
	}

	/** 写入配置补丁并刷新扫描缓存（enabled/trusted/assignments 变化后调用） */
	async updateConfig(patch: Partial<UiPluginsConfig>): Promise<void> {
		await saveUiPluginsConfig(patch);
		await this.scanAll();
	}
}
