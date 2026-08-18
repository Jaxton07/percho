import { existsSync, type FSWatcher, watch } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@percho/backend";
import {
	KNOWN_UI_REGIONS,
	KNOWN_UI_SLOTS,
	UI_PLUGIN_ANCHORS,
	type UiPluginContribution,
	type UiPluginInfo,
	type UiPluginManifest,
	type UiPluginsConfig,
} from "@percho/shared";
import { app } from "electron";
import { buildPlugin } from "./build";
import { defaultUiPluginsConfig, loadUiPluginsConfig, saveUiPluginsConfig } from "./config";

const log = createLogger("ui-plugins");

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAIN_RE = /\.(ts|tsx|js|jsx)$/;
const CONTRIBUTION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function pluginsDir(): string {
	return join(app.getPath("userData"), "ui-plugins");
}

/** 内置插件源码目录（随包分发，packaged 态在 .app 内只读）；init 时导出到用户插件目录 */
function builtinPluginsDir(): string {
	return join(uiPluginsResourcesDir(), "builtin");
}

/** 内置插件导出戳：记录上次导出时的应用版本（点开头过不了 NAME_RE，不会被当插件扫描） */
function builtinSeedStampPath(): string {
	return join(pluginsDir(), ".builtin-seed.json");
}

/**
 * 导出内置插件到用户插件目录——之后与用户插件走**同一条**扫描/构建/热重载/读码路径，无特殊分支。
 * 策略：仅首次安装 / 应用版本变化时整树刷新（copyTree 内容一致自动跳过）；同版本重启直接返回零开销；
 * dev 态每次跑 copyTree（一致跳过 ≈ 零开销，源码迭代即时生效）。
 * 边界语义：手动删除某内置目录 → 本版本内不再回来（尊重删除），下次升级重新导出；
 * 直接改内置副本 → 升级时被覆盖（注释与 SPEC 都写明：魔改请把目录改名另存，面板「打开目录」可达）。
 */
async function seedBuiltinPlugins(): Promise<void> {
	const stampPath = builtinSeedStampPath();
	const version = app.getVersion();
	const stamp = await readFile(stampPath, "utf-8")
		.then((s) => JSON.parse(s) as { version?: string })
		.catch(() => null);
	if (app.isPackaged && stamp?.version === version) return;
	const src = builtinPluginsDir();
	const entries = await readdir(src, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
		await copyTree(join(src, entry.name), join(pluginsDir(), entry.name));
	}
	await writeFile(stampPath, JSON.stringify({ version }), "utf-8").catch((err) =>
		log.error("builtin seed stamp failed", err),
	);
}

/** 随包资源目录：dev 态 = packages/desktop/resources/ui-plugins；packaged 态 = resources/ui-plugins（extraResources 镜像） */
export function uiPluginsResourcesDir(): string {
	return app.isPackaged
		? join(process.resourcesPath, "ui-plugins")
		: join(__dirname, "../../resources/ui-plugins");
}

/**
 * 分发 agent 规范三件套：SPEC.md / percho-ui.d.ts 拷贝进 userData/ui-plugins/（内容一致跳过），
 * examples/ 整体拷为 `_examples/`（下划线开头过不了 NAME_RE，scanAll 天然忽略、不会当插件扫描）；
 * 并确保 symlink ~/.percho/ui-plugins → userData/ui-plugins（给 agent 一个不随 dev/prod 漂移的稳定路径）。
 * 任一步失败只告警不致命（插件加载不受影响）。
 */
async function seedDocs(): Promise<void> {
	const root = pluginsDir();
	for (const file of ["SPEC.md", "percho-ui.d.ts"]) {
		try {
			const [src, dst] = await Promise.all([
				readFile(join(uiPluginsResourcesDir(), file)),
				readFile(join(root, file)).catch(() => null),
			]);
			if (dst && src.equals(dst)) continue; // 内容一致跳过（尊重用户手动改过的版本）
			await writeFile(join(root, file), src);
		} catch (err) {
			log.error("seed doc failed", file, err);
		}
	}
	// examples 示例插件目录（拷成 _examples 防被 scanAll 当插件扫描）
	await copyTree(join(uiPluginsResourcesDir(), "examples"), join(root, "_examples"));
	const link = join(homedir(), ".percho", "ui-plugins");
	try {
		const existing = await lstat(link).catch(() => null);
		if (existing?.isSymbolicLink()) {
			if ((await realpath(link)) !== root) {
				log.warn("~/.percho/ui-plugins symlink 指向其他位置，跳过");
			}
		} else if (existing) {
			log.warn("~/.percho/ui-plugins 已存在且非 symlink，跳过");
		} else {
			await mkdir(join(homedir(), ".percho"), { recursive: true });
			await symlink(root, link);
		}
	} catch (err) {
		log.error("symlink ~/.percho/ui-plugins failed", err);
	}
}

/** manifest 校验（spec §5 + §16）：任一不满足 → 返回原因，插件标记 invalid 不参与加载 */
function validateManifest(dirName: string, m: Partial<UiPluginManifest>): string | null {
	if (!m || typeof m !== "object") return "plugin.json 缺失或损坏";
	if (typeof m.name !== "string" || !NAME_RE.test(m.name) || m.name !== dirName) {
		return `name 非法（须匹配 ${NAME_RE.source} 且与目录名一致）`;
	}
	if (m.perchoUi !== 1) return "perchoUi 版本不匹配（当前只接受 1）";
	if (typeof m.main !== "string" || m.main.includes("..") || !MAIN_RE.test(m.main)) {
		return "main 非法（须为目录内相对路径，禁止 .. 穿越，后缀 .ts/.tsx/.js/.jsx）";
	}
	// slots 与 contributions 至少其一非空（spec §16：slots 不再必填）
	const slotsOk = !!m.slots && typeof m.slots === "object" && Object.keys(m.slots).length > 0;
	if (m.contributions !== undefined && !Array.isArray(m.contributions)) {
		return "contributions 必须是数组";
	}
	if (!slotsOk && (m.contributions?.length ?? 0) === 0) {
		return "slots 与 contributions 至少其一非空";
	}
	if (slotsOk) {
		for (const [slot, exportName] of Object.entries(m.slots ?? {})) {
			if (!KNOWN_UI_SLOTS.includes(slot)) return `槽位 ${slot} 未知`;
			if (typeof exportName !== "string" || exportName.length === 0) return `槽位 ${slot} 的导出名非法`;
		}
	}
	// contributions 逐条校验；未知 region 校验报警告并忽略该条（不判 invalid，spec §16 版本前瞻）
	const seenIds = new Set<string>();
	for (const c of m.contributions ?? []) {
		if (!c || typeof c !== "object") return "contributions 条目非法";
		if (typeof c.region !== "string" || !KNOWN_UI_REGIONS.includes(c.region)) {
			log.warn(`manifest contribution 忽略未知 region:`, JSON.stringify(c));
			continue; // 未知 region 条目整体跳过（含其 id/export，宿主无从校验新契约）
		}
		if (typeof c.id !== "string" || !CONTRIBUTION_ID_RE.test(c.id)) {
			return `contribution ${String(c.id)} 的 id 非法（须匹配 ${CONTRIBUTION_ID_RE.source}）`;
		}
		if (seenIds.has(c.id)) return `contribution id 重复：${c.id}`;
		seenIds.add(c.id);
		if (typeof c.export !== "string" || c.export.length === 0) {
			return `contribution ${c.id} 的 export 非法`;
		}
		if (
			c.anchor !== undefined &&
			!UI_PLUGIN_ANCHORS.includes(c.anchor as (typeof UI_PLUGIN_ANCHORS)[number])
		) {
			return `contribution ${c.id} 的 anchor 非法（须为九宫格枚举）`;
		}
	}
	return null;
}

/**
 * 过滤 contributions：剔除未知 region 条目（scanAll 合成 info 与 readCode 返回的 manifest 都用这份），
 * 并把非 app.overlay 区域的 anchor 剥离（anchor 仅对 overlay 有意义）。
 */
function filterContributions(contributions: UiPluginContribution[] | undefined): UiPluginContribution[] {
	if (!contributions) return [];
	const out: UiPluginContribution[] = [];
	for (const c of contributions) {
		if (!c || typeof c.region !== "string" || !KNOWN_UI_REGIONS.includes(c.region)) continue;
		out.push(c.region === "app.overlay" ? c : { ...c, anchor: undefined });
	}
	return out;
}

/** 读插件目录下的 plugin.json；解析失败返回 null */
async function readManifest(dir: string): Promise<Partial<UiPluginManifest> | null> {
	try {
		const raw = await readFile(join(dir, "plugin.json"), "utf-8");
		return JSON.parse(raw) as Partial<UiPluginManifest>;
	} catch {
		return null;
	}
}

/** 目录级拷贝：递归比较（文件逐字节、目录递归），内容一致则跳过；失败只告警 */
async function copyTree(src: string, dst: string): Promise<void> {
	try {
		const srcStat = await stat(src);
		if (srcStat.isDirectory()) {
			const [srcEntries, dstExists] = await Promise.all([readdir(src), stat(dst).catch(() => null)]);
			if (dstExists?.isDirectory()) {
				let allSame = true;
				for (const entry of srcEntries) {
					if (!(await sameTree(join(src, entry), join(dst, entry)))) {
						allSame = false;
						break;
					}
				}
				if (allSame) return;
			}
			await rm(dst, { recursive: true, force: true });
			await cp(src, dst, { recursive: true });
		}
	} catch (err) {
		log.error("copyTree failed", src, err);
	}
}

/** 递归一致性比较：文件逐字节、目录递归、缺失/类型不同视为不一致（不再对目录 readFile 抛 EISDIR） */
async function sameTree(a: string, b: string): Promise<boolean> {
	const [sa, sb] = await Promise.all([stat(a), stat(b).catch(() => null)]);
	if (!sb || sa.isDirectory() !== sb.isDirectory()) return false;
	if (sa.isFile()) {
		const [fa, fb] = await Promise.all([readFile(a), readFile(b)]);
		return fa.equals(fb);
	}
	if (sa.isDirectory()) {
		const [ea, eb] = await Promise.all([readdir(a), readdir(b)]);
		if (ea.length !== eb.length) return false;
		for (const entry of ea) {
			if (!eb.includes(entry)) return false;
			if (!(await sameTree(join(a, entry), join(b, entry)))) return false;
		}
		return true;
	}
	return false; // 其它类型（symlink 等）视为不一致，重拷
}

/** 目录内所有文件的最新 mtime（构建陈旧性判断：源码比产物新即重建） */
async function newestMtime(dir: string): Promise<number | null> {
	let newest: number | null = null;
	const walk = async (d: string) => {
		const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) {
				await walk(p);
			} else {
				const s = await stat(p).catch(() => null);
				if (s && (newest === null || s.mtimeMs > newest)) newest = s.mtimeMs;
			}
		}
	};
	await walk(dir);
	return newest;
}

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
			seen.add(name);
			this.dirNames.set(name, join(dir, name));
			const info = await this.scanOne(name, join(dir, name));
			this.infos.set(name, info);
			out.push(info);
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
