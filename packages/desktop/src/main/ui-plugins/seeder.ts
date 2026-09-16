import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@percho/backend";
import { app } from "electron";
import { copyTree } from "./fs-tree";
import { NAME_RE } from "./manifest";

const log = createLogger("ui-plugins");

export function pluginsDir(): string {
	return join(app.getPath("userData"), "ui-plugins");
}

/** 内置插件源码目录（随包分发，packaged 态在 .app 内只读）；init 时导出到用户插件目录 */
export function builtinPluginsDir(): string {
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
export async function seedBuiltinPlugins(): Promise<void> {
	const stampPath = builtinSeedStampPath();
	const version = app.getVersion();
	const stamp = await readFile(stampPath, "utf-8")
		.then((s) => JSON.parse(s) as { version?: string })
		.catch(() => null);
	if (app.isPackaged && stamp?.version === version) return;
	const src = builtinPluginsDir();
	const entries = await readdir(src, { withFileTypes: true }).catch(() => []);
	let allOk = true;
	for (const entry of entries) {
		if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
		const ok = await copyTree(join(src, entry.name), join(pluginsDir(), entry.name));
		if (!ok) allOk = false;
	}
	if (!allOk) {
		// 任一导出失败不写版本戳，下次启动重试（否则部分插件缺失被版本戳永久遮蔽，B9）
		log.error("builtin plugins seed incomplete, will retry next launch");
		return;
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
 * 分发 agent 规范三件套：SPEC.md / percho-ui.d.ts 是**宿主管理的契约文档**（agent 按它写插件），
 * 始终更新到随包版本（内容一致跳过避免无谓写入），用户不应手改——这不是用户配置。
 * examples/ 整体拷为 `_examples/`（下划线开头过不了 NAME_RE，scanAll 天然忽略、不会当插件扫描）；
 * 并确保 symlink ~/.percho/ui-plugins → userData/ui-plugins（给 agent 一个不随 dev/prod 漂移的稳定路径）。
 * 任一步失败只告警不致命（插件加载不受影响）。
 */
export async function seedDocs(): Promise<void> {
	const root = pluginsDir();
	for (const file of ["SPEC.md", "percho-ui.d.ts"]) {
		try {
			const [src, dst] = await Promise.all([
				readFile(join(uiPluginsResourcesDir(), file)),
				readFile(join(root, file)).catch(() => null),
			]);
			if (dst && src.equals(dst)) continue; // 内容一致跳过（避免无谓写入；契约文档始终以随包版本为准）
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
			// Windows 普通用户建符号链接需管理员/开发者模式（EPERM 必现，#28 附报）；
			// junction 目录联接不需提权，行为等价（目录型链接、跟随重定向）；
			// 其他平台保持真 symlink（lstat/realpath 判定与上面一致，junction 在 POSIX 不可用）
			await symlink(root, link, process.platform === "win32" ? "junction" : undefined);
		}
	} catch (err) {
		// 链接失败只告警：插件功能不受影响（真实目录在 userData/ui-plugins），
		// 只是 agent 按规范路径 ~/.percho/ui-plugins 读不到，提示真实路径便于排查
		log.error(`symlink ~/.percho/ui-plugins failed（真实插件目录：${root}）`, err);
	}
}
