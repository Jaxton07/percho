import type { PiBackend } from "@percho/backend";
import { createLogger } from "@percho/backend";
import { app, BrowserWindow, dialog } from "electron";
import { consoleDedupLogLine, consoleSignature, createConsoleDeduper } from "./console-dedup";

/**
 * renderer 进程看护（从 main/index.ts 抽出，index 回归纯装配）：
 * - 进程级崩溃 → 日志 + 临终快照 + 自动 reload（短窗高频崩溃停手转人工对话框）
 * - console 错误签名去重（首次全量/重复计数/周期汇总）
 * - 60s 心跳（renderer 内存 + 每会话事件速率；白屏/冻结事故「死前多忙」的最后读数）
 * 快照/心跳只记 id/速率/内存数字，绝不记消息正文。
 */

/** 心跳周期（60s：事故形态是小时级爬坡，太快会把心跳自己变成噪音） */
const HEARTBEAT_INTERVAL_MS = 60_000;

const log = createLogger("renderer");

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

/**
 * 接线看护（backend 就绪后、窗口创建前调用）。
 * backend 经惰性 getter 引用（崩溃早于 backend 初始化时同原行为：窗口在 backend 之后才创建）。
 */
/** console 错误签名去重（事故实录：monaco 一天 1005 条近似重复）：首次全量、重复计数、阈值/周期汇总 */
const consoleDedup = createConsoleDeduper();

export function attachRendererWatchdog(backend: PiBackend): void {
	// 0.5.2 白屏事故（2026-08-27 04:39）：流式 IPC 洪水下 renderer 被 SIGTERM 杀死，
	// 主进程/会话健在（LAN 页仍在跑）但窗口永久空白。AppErrorBoundary 只能接 React 层异常，
	// 进程级死亡必须在这里兜底 reload；短窗高频崩溃则停手转人工（防崩溃循环反复闪屏）
	const RELOAD_WINDOW_MS = 30_000;
	const MAX_AUTO_RELOADS = 3;
	const crashReloads: number[] = [];

	const incidentSnapshot = (details: { reason: string; exitCode: number }) => ({
		reason: details.reason,
		exitCode: details.exitCode,
		processes: summarizeProcesses(app.getAppMetrics()),
		sessions: summarizeRates(backend.getEventRates()),
		uptimeMs: Math.round(process.uptime() * 1000),
	});

	app.on("web-contents-created", (_e, contents) => {
		contents.on("render-process-gone", (_event, details) => {
			log.error("render process gone", details);
			// clean-exit：reload/quit 等正常退出也触发本事件，不是崩溃
			if (details.reason === "clean-exit") return;
			// 临终快照（决策 3）：谁杀的/死前多忙/内存多高——reload 前同步取数，避免异步竞态。
			// 只记 id/速率/内存数字，绝不记消息正文
			log.error("incident snapshot", incidentSnapshot(details));
			const now = Date.now();
			while (crashReloads.length > 0 && now - (crashReloads[0] ?? 0) > RELOAD_WINDOW_MS) crashReloads.shift();
			if (crashReloads.length >= MAX_AUTO_RELOADS) {
				log.error("renderer crash loop, auto reload suspended", {
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
			log.info("renderer crashed, auto reloading", {
				reason: details.reason,
				exitCode: details.exitCode,
			});
			contents.reload();
		});
		contents.on("unresponsive", () => {
			log.warn("renderer unresponsive");
		});
		contents.on("console-message", (details) => {
			// details.level: debug / info / warning / error（Electron 37+ 对象形式，旧数值签名已废弃）
			const { level, message, lineNumber, sourceId } = details;
			if (level === "error") {
				// 去重只对 error 分支（决策 4）；debug 本来就低价值，行为不变
				const signature = consoleSignature(message, sourceId);
				const decision = consoleDedup.observe(signature);
				if (decision.summary) {
					log.error(...consoleDedupLogLine(decision.summary));
				} else if (decision.logFull) {
					log.error("renderer console", { message, line: lineNumber, sourceId });
				}
			} else {
				log.debug("renderer console", { message, line: lineNumber, sourceId });
			}
		});
	});

	// 心跳（决策 3，60s unref）：renderer 内存 + 每会话事件速率——白屏/冻结事故「死前多忙」的
	// 最后读数；快照/心跳只记 id/速率/内存数字，绝不记消息正文
	const heartbeat = setInterval(() => {
		try {
			const tabs = app.getAppMetrics().filter((m) => m.type === "Tab");
			const rendererMemoryMb = Math.round(tabs.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024);
			log.info("renderer heartbeat", {
				rendererMemoryMb,
				sessions: summarizeRates(backend.getEventRates()),
			});
		} catch (err) {
			log.warn("renderer heartbeat failed", err);
		}
	}, HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();
	// console 错误汇总周期 flush（决策 4）：慢烧场景补一条，有界不噪声
	const consoleFlush = setInterval(() => {
		for (const summary of consoleDedup.flush()) log.error(...consoleDedupLogLine(summary));
	}, HEARTBEAT_INTERVAL_MS);
	consoleFlush.unref();
}
