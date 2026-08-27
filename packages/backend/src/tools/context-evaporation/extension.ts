import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../log";
import { readContextManagerMode, readEvapConfig } from "./config";
import { evaporateWire } from "./evaporate";
import type { EvapWireMessage } from "./types";
import { createEvapState, type EvapBatchInfo, type EvapConfig, type EvapState } from "./types";

const log = createLogger("context-evaporation");

/**
 * 上下文蒸发 — 内置扩展（P2 接线）。
 *
 * 接线一览（全部 try/catch，钩子绝不 throw；异常 → log + 返回 undefined 原样放行）：
 * - session_start：全新空决策 Map（startup/resume/new/fork/reload 一律重来——冷启动
 *   重算安全，replay §5.5：重算集 ⊇ live 集，首 call 一次性补齐且本就全量 cache miss）
 * - context：liveEnabled 实时读派生 mode（2s TTL）→ withLock → evaporateWire 纯函数
 *   → 有动作时 reporter(batch)（P3 起接 trace）；Tier 0 / 无变化返回 undefined 零干扰
 * - session_compact：重置决策 Map（arch §4.2：compact 边界前的 part 整体消失，防幽灵决策）
 *
 * 二态激活（单一写者保证）：mode==="evaporation" 才启用（缺省即蒸发），off 可运行时关闭，
 * 切换 ≤2s 生效免重开会话。
 *
 * 扩展不注册任何工具、不改 system prompt——stub 自带恢复指令，零 prompt 污染。
 */

export interface EvapExtensionOptions {
	agentDir: string;
	/** 开关判定（缺省 readContextManagerMode(agentDir) === "evaporation"，测试可注入） */
	isEnabled?: () => boolean;
	/** 配置读取（缺省 readEvapConfig(agentDir)，测试可注入） */
	getConfig?: () => EvapConfig;
	/** 批次上报（PiBackend 注入：log + trace recordCustom；缺省仅 log.info）。
	 *  sessionId 来自 session_start 时的会话闭包（trace 按会话落盘） */
	reporter?: (sessionId: string, batch: EvapBatchInfo) => void;
}

export function makeEvapExtension(options: EvapExtensionOptions): InlineExtension {
	return {
		name: "context-evaporation",
		factory: (pi) => {
			const enabled = options.isEnabled ?? (() => readContextManagerMode(options.agentDir) === "evaporation");
			const getConfig = options.getConfig ?? (() => readEvapConfig(options.agentDir));
			const report =
				options.reporter ?? ((sessionId: string, batch: EvapBatchInfo) => reportBatch(sessionId, batch));
			let currentSessionId = "";

			// --- 会话闭包状态（context 钩子经 withLock 串行访问） ---
			let active = false;
			let state: EvapState = createEvapState();

			/** 实时生效判定：active 表示 session_start 时曾启用，
			 * 开关同进程翻转（开→关）时闭包 active 停留 true，入口每次实时读 enabled() */
			const liveEnabled = (): boolean => active && enabled();

			let lockTail: Promise<unknown> = Promise.resolve();
			function withLock<T>(fn: () => Promise<T>): Promise<T> {
				const run = lockTail.then(fn, fn);
				lockTail = run.then(
					() => {},
					() => {},
				);
				return run;
			}

			/** 窗口分母（arch §2.2）：min(model.contextWindow, budgetTokens)——SDK
			 * getContextUsage().percent 的分母是 model.contextWindow（1M 模型上语义错误），
			 * 必须用 tokens 自行除以 effectiveWindow；model 缺失时退化为纯预算 */
			function windowTokensFor(ctx: ExtensionContext | undefined, config: EvapConfig): number {
				const modelWindow = ctx?.model?.contextWindow ?? 0;
				return Math.min(modelWindow, config.budgetTokens) || config.budgetTokens;
			}

			// --- 生命周期 ---
			pi.on("session_start", async (_event, ctx) => {
				try {
					if (!enabled()) {
						active = false;
						return;
					}
					active = true;
					state = createEvapState();
					currentSessionId = ctx.sessionManager.getSessionId();
					log.info("evaporation enabled", { sessionId: currentSessionId });
				} catch (err) {
					// 启用判定失败 → 降级为关闭（会话照常，SDK 默认路径不变）
					active = false;
					log.error("evaporation session_start 失败，降级关闭", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});

			pi.on("session_compact", async (_event) => {
				try {
					if (!active) return;
					// SDK 原生压缩（Tier 3 兜底）后：compact 边界截断使历史被摘要重写，
					// 重置决策防幽灵（幸存 part 暂回 full 形态，compact 已作废前缀 cache，无额外损失）
					state = createEvapState();
					log.info("evaporation 决策已重置（SDK compaction 后）");
				} catch (err) {
					log.warn("evaporation 决策重置失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});

			// --- context 管道（每次 LLM 调用前） ---
			pi.on("context", async (event, ctx) => {
				if (!liveEnabled()) return undefined;
				return withLock(async () => {
					const config = getConfig();
					const windowTokens = windowTokensFor(ctx, config);
					// 真实 usage 优先；tokens=null（compaction 后首轮）或读取异常 → 内部估算兜底
					let usageTokens: number | null = null;
					try {
						usageTokens = ctx.getContextUsage()?.tokens ?? null;
					} catch {
						usageTokens = null;
					}
					const wire = event.messages as unknown as EvapWireMessage[];
					const result = evaporateWire(wire, state, config, {
						windowTokens,
						usageTokens,
					});
					if (result.batch.snipped + result.batch.pruned > 0) {
						report(currentSessionId, result.batch);
					}
					// 无变化（Tier 0 或零决策）→ undefined 原样放行，零干扰
					if (result.messages === wire) return undefined;
					return { messages: result.messages as unknown as typeof event.messages };
				}).catch((err: unknown) => {
					// context 钩子契约：绝不 throw，异常原样放行（wire 不变 = 行为与未装蒸发一致）
					log.error("evaporation context 变换失败，原样放行", {
						error: err instanceof Error ? err.message : String(err),
					});
					return undefined;
				});
			});
		},
	};
}

/** 批次日志（可观测；字段 = arch §8 字段表）。PiBackend 的 trace reporter 也复用它保 log。
 *  sessionId 只记短 8 位（决策 5：列宽 + 足以 grep 反查，完整 id 看会话文件名） */
export function reportEvapBatch(sessionId: string, batch: EvapBatchInfo): void {
	reportBatch(sessionId, batch);
}

function reportBatch(sessionId: string, batch: EvapBatchInfo): void {
	log.info("evap batch", {
		sessionId: sessionId.slice(0, 8),
		tier: batch.tier,
		usagePct: Math.round(batch.usagePct * 10) / 10,
		snipped: batch.snipped,
		pruned: batch.pruned,
		savedEstTokens: Math.round(batch.savedEstTokens),
		wireEstTokens: Math.round(batch.wireEstTokens),
		cacheHits: batch.cacheHits,
		mapSize: batch.mapSize,
	});
}
