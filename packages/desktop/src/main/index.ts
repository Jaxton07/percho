import "./pi-package-dir";
import "./dev-agent-dir";
import "./fix-path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger, initLogging, PiBackend } from "@percho/backend";
import { app, BrowserWindow, dialog, Menu, nativeTheme, net, protocol } from "electron";
import { backgroundsDir } from "./background";
import { consoleDedupLogLine, consoleSignature, createConsoleDeduper } from "./console-dedup";
import { registerIpc } from "./ipc";
import { initLanObserver, type LanObserverHandle } from "./lan";
import { UiPluginManager, uiPluginsResourcesDir } from "./ui-plugins/manager";
import { loadUiState } from "./ui-state";
import { initUpdater, scheduleAutoUpdateCheck } from "./updater";
import { applyChromeTheme, createWindow, resolveTheme } from "./window";

const log = createLogger("main");
let backend: PiBackend;
let uiPluginsManager: UiPluginManager;
let lanObserver: LanObserverHandle | undefined;

/**
 * 追加进每次会话系统提示词的桌面端段落（每次调用都付费，保持精简）。
 * 让 agent 知道自己跑在 Percho 桌面端、界面可被 UI 插件定制、以及定制流程与信任门。
 */
const UI_PLUGIN_PROMPT: string[] = [
	"你运行在 Percho 桌面端（Electron 图形界面），用户通过图形聊天界面与你交互，不是 CLI 终端。",
	"Percho 的界面可以用 UI 插件定制：当前可替换「工具调用卡 / 子代理卡 / 任务列表面板」三处组件。",
	"用户想改界面、或问「界面能改什么」时：读 ~/.percho/ui-plugins/SPEC.md（示例在 _examples/ 目录），按规范写一个插件，保存即自动热重载。",
	"写完引导用户去「设置 → UI 插件」打开总开关并启用（信任门：agent 不能代劳）。",
];

/** renderer 加载自定义背景图的协议（pi-bg://background/<文件名>，只读 userData/backgrounds/） */
const BG_PROTOCOL = "pi-bg";

/** 心跳周期（60s：事故形态是小时级爬坡，太快会把心跳自己变成噪音） */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** 每会话事件速率摘要（心跳与临终快照共用）：短 id 可 grep 反查，只记数字不记内容 */
function summarizeRates(
	rates: Map<string, { window60s: number[]; lastEventAt: number }>,
	now = Date.now(),
): { id: string; rate1m: number; lastEventAgeMs: number }[] {
	return [...rates.entries()].map(([id, r]) => ({
		id: id.slice(0, 8),
		rate1m: r.window60s.reduce((a, b) => a + b, 0),
		lastEventAgeMs: Math.max(0, now - r.lastEventAt),
	}));
}

/** renderer/gpu 进程资源摘要（appMetrics 里 renderer 进程的 type 为 "Tab"；
 *  本版 Electron CPUUsage 无 percent 字段，只取内存 workingSetSize(KB)） */
function summarizeProcesses(metrics: ReturnType<typeof app.getAppMetrics>) {
	return metrics
		.filter((m) => m.type === "Tab" || m.type === "GPU")
		.map((m) => ({ type: m.type, memoryMb: Math.round(m.memory.workingSetSize / 1024) }));
}

/** 临终快照（决策 3）：崩溃原因/进程资源/每会话事件速率与最近事件距 crash 的毫秒数——
 *  区分「正在流式输出中死亡」vs「空闲死亡」，事故归因关键 */
function buildIncidentSnapshot(details: { reason: string; exitCode: number }): {
	reason: string;
	exitCode: number;
	processes: ReturnType<typeof summarizeProcesses>;
	sessions: { id: string; rate1m: number; lastEventAgeMs: number }[];
	uptimeMs: number;
} {
	return {
		reason: details.reason,
		exitCode: details.exitCode,
		processes: summarizeProcesses(app.getAppMetrics()),
		sessions: summarizeRates(backend.getEventRates()),
		uptimeMs: Math.round(process.uptime() * 1000),
	};
}

protocol.registerSchemesAsPrivileged([
	{ scheme: BG_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Windows/Linux 不显示默认应用菜单（File/Edit/...）；macOS 菜单在系统菜单栏且承担复制粘贴等快捷键，保留
if (process.platform !== "darwin") Menu.setApplicationMenu(null);
// 系统深浅色变化（或用户切换主题导致 themeSource 变更）→ 同步窗口底色与 Windows 窗口按钮覆盖层
nativeTheme.on("updated", () => applyChromeTheme(nativeTheme.themeSource));

app.whenReady().then(async () => {
	initLogging(join(app.getPath("userData"), "logs"));
	log.info("app ready", { version: app.getVersion(), userData: app.getPath("userData") });

	// 自定义背景图协议：pi-bg://background/<文件名> → userData/backgrounds/<文件名>（文件名白名单防路径穿越）
	protocol.handle(BG_PROTOCOL, (request) => {
		const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
		if (!/^[\w.-]+$/.test(name)) return new Response("invalid background name", { status: 400 });
		return net.fetch(pathToFileURL(join(backgroundsDir(), name)).toString());
	});

	// renderer 异常/崩溃 → 日志（错误排查依赖 trace + 日志）+ 进程级死亡自动恢复
	const crashLog = createLogger("renderer");
	// console 错误签名去重（事故实录：monaco 一天 1005 条近似重复）：首次全量、重复计数、
	// 阈值/周期汇总；60s flush 定时器在 backend 初始化后统一启动（unref）
	const consoleDedup = createConsoleDeduper();
	// 0.5.2 白屏事故（2026-08-27 04:39）：流式 IPC 洪水下 renderer 被 SIGTERM 杀死，
	// 主进程/会话健在（LAN 页仍在跑）但窗口永久空白。AppErrorBoundary 只能接 React 层异常，
	// 进程级死亡必须在这里兜底 reload；短窗高频崩溃则停手转人工（防崩溃循环反复闪屏）
	const RELOAD_WINDOW_MS = 30_000;
	const MAX_AUTO_RELOADS = 3;
	const crashReloads: number[] = [];
	app.on("web-contents-created", (_e, contents) => {
		contents.on("render-process-gone", (_event, details) => {
			crashLog.error("render process gone", details);
			// clean-exit：reload/quit 等正常退出也触发本事件，不是崩溃
			if (details.reason === "clean-exit") return;
			// 临终快照（决策 3）：谁杀的/死前多忙/内存多高——reload 前同步取数，避免异步竞态。
			// 只记 id/速率/内存数字，绝不记消息正文
			crashLog.error("incident snapshot", buildIncidentSnapshot(details));
			const now = Date.now();
			while (crashReloads.length > 0 && now - (crashReloads[0] ?? 0) > RELOAD_WINDOW_MS) crashReloads.shift();
			if (crashReloads.length >= MAX_AUTO_RELOADS) {
				crashLog.error("renderer crash loop, auto reload suspended", {
					windowMs: RELOAD_WINDOW_MS,
					count: crashReloads.length,
				});
				const win = BrowserWindow.fromWebContents(contents);
				const options: Electron.MessageBoxOptions = {
					type: "error",
					title: "Percho",
					message: "界面进程反复崩溃",
					detail: "自动恢复已暂停，避免崩溃循环。可重试加载或退出（后台任务不受影响）。",
					buttons: ["重新加载", "退出"],
					defaultId: 0,
					noLink: true,
				};
				void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then(
					({ response }) => {
						if (response === 0) {
							crashReloads.length = 0;
							contents.reload();
						} else {
							app.quit();
						}
					},
				);
				return;
			}
			crashReloads.push(now);
			crashLog.info("renderer crashed, auto reloading", {
				reason: details.reason,
				exitCode: details.exitCode,
			});
			contents.reload();
		});
		contents.on("unresponsive", () => {
			crashLog.warn("renderer unresponsive");
		});
		contents.on("console-message", (details) => {
			// details.level: debug / info / warning / error（Electron 37+ 对象形式，旧数值签名已废弃）
			const { level, message, lineNumber, sourceId } = details;
			if (level === "error") {
				// 去重只对 error 分支（决策 4）；debug 本来就低价值，行为不变
				const signature = consoleSignature(message, sourceId);
				const decision = consoleDedup.observe(signature);
				if (decision.summary) {
					crashLog.error(...consoleDedupLogLine(decision.summary));
				} else if (decision.logFull) {
					crashLog.error("renderer console", { message, line: lineNumber, sourceId });
				}
			} else {
				crashLog.debug("renderer console", { message, line: lineNumber, sourceId });
			}
		});
	});

	process.on("uncaughtException", (err) => {
		log.error("uncaught exception", err);
	});
	process.on("unhandledRejection", (reason) => {
		log.error("unhandled rejection", reason);
	});

	backend = new PiBackend({
		// 桌面端集成：UI 插件技能目录 + 内置协作 skill 目录（均随包分发）+ 系统提示词段落
		desktopIntegration: {
			appendSystemPrompt: UI_PLUGIN_PROMPT,
			additionalSkillPaths: [
				join(uiPluginsResourcesDir(), "skills"),
				// 内置协作 skill（channel-pickup/design-handoff）：语义上与 UI 插件无关，独立目录分发
				app.isPackaged ? join(process.resourcesPath, "skills") : join(__dirname, "../../resources/skills"),
			],
		},
	});
	await backend.init();

	// 心跳（决策 3，60s unref）：renderer 内存 + 每会话事件速率——白屏/冻结事故「死前多忙」的
	// 最后读数；快照/心跳只记 id/速率/内存数字，绝不记消息正文
	const heartbeat = setInterval(() => {
		try {
			const tabs = app.getAppMetrics().filter((m) => m.type === "Tab");
			const rendererMemoryMb = Math.round(tabs.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024);
			crashLog.info("renderer heartbeat", {
				rendererMemoryMb,
				sessions: summarizeRates(backend.getEventRates()),
			});
		} catch (err) {
			crashLog.warn("renderer heartbeat failed", err);
		}
	}, HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();
	// console 错误汇总周期 flush（决策 4）：慢烧场景补一条，有界不噪声
	const consoleFlush = setInterval(() => {
		for (const summary of consoleDedup.flush()) crashLog.error(...consoleDedupLogLine(summary));
	}, HEARTBEAT_INTERVAL_MS);
	consoleFlush.unref();
	lanObserver = await initLanObserver(
		backend,
		join(app.getPath("userData"), "lan-observer.json"),
		join(app.getPath("userData"), "lan-audit.jsonl"),
	);
	uiPluginsManager = new UiPluginManager();
	await uiPluginsManager.init();
	registerIpc(backend, uiPluginsManager, lanObserver);
	await initUpdater();
	scheduleAutoUpdateCheck();
	const uiState = await loadUiState();
	// main 进程原生主题与 app 设置对齐（Windows 窗口按钮覆盖层/后续主题切换的 system 解析依赖它）
	nativeTheme.themeSource = uiState?.theme ?? "system";
	createWindow(resolveTheme(uiState?.theme));

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(resolveTheme(uiState?.theme));
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	void lanObserver?.stop();
	backend?.dispose();
	uiPluginsManager?.disposeWatcher();
});
