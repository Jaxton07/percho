import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../log";
import { boundMessages } from "./bound";
import { readCompactionGuardConfig } from "./config";
import type { GuardState } from "./guard";
import {
	applyOutcome,
	createGuardState,
	decideTrigger,
	hardCapTokens,
	judgeOutcome,
	recordTrigger,
} from "./guard";
import type {
	CompactionBoundStats,
	CompactionGuardConfig,
	CompactionGuardObservation,
	CompactionPercentBasis,
	GuardMessage,
} from "./types";

const log = createLogger("compaction-guard");

/**
 * 压缩护栏 — 内置扩展（spec: .local/agent-work/spec/compaction-bounded.md）。
 *
 * 本扩展做三件事：
 * 1. **百分比触发**（`agent_settled` 内**同步**判定 + `ctx.compact()`，spec D1/D2）——
 *    替代 SDK「窗口 − 16384」那条绝对余量线（1M 窗口上 = 98.4%，等于永不触发）。
 * 2. **摘要输入有界**（`session_before_compact`，spec D3）——层 1 降级 + 层 2 硬上限，两份请求各跑一遍。
 * 3. **观测**（spec D6）：trigger / bound / settled 三个相位各记一行 `compaction_guard`（log + trace）。
 *
 * 默认常开、无 UI 开关（spec D7）；逃生舱是 settings.json 的 `compactionGuard.enabled=false`。
 * 与设置页那个「上下文管理」（蒸发）开关**完全解耦**（spec D7b）：不读、不跟随、不改它。
 *
 * 所有钩子都 try/catch 全包：本扩展出错必须原样放行，绝不能让压缩整体失败（spec §5）。
 */

export interface CompactionGuardExtensionOptions {
	agentDir: string;
	/** 配置读取（缺省 `readCompactionGuardConfig(agentDir)`，测试可注入） */
	getConfig?: () => CompactionGuardConfig;
	/** 观测上报的**附加**通道（PiBackend 注入 → trace_custom 行；log 通道本扩展自己写，恒有） */
	reporter?: (sessionId: string, observation: CompactionGuardObservation) => void;
	/** 时钟（测试注入） */
	now?: () => number;
	/** 序列化器（缺省 SDK 同源；测试/离线重放可注入轻量实现） */
	serialize?: (messages: GuardMessage[]) => string;
}

/**
 * SDK 同源的「摘要请求正文」序列化器：`convertToLlm → serializeConversation`。
 * 与 SDK 构造摘要 prompt 的口径逐字节一致（本扩展与离线脚本共用，避免两处漂移）。
 */
export function sdkSerializer(): (messages: GuardMessage[]) => string {
	return (messages) => serializeConversation(convertToLlm(messages as never));
}

/** 一次压缩尝试的记账（自研触发的那次） */
interface Attempt {
	percent: number;
	tokensBefore: number;
}

export function makeCompactionGuardExtension(options: CompactionGuardExtensionOptions): InlineExtension {
	return {
		name: "compaction-guard",
		factory: (pi) => {
			const getConfig = options.getConfig ?? (() => readCompactionGuardConfig(options.agentDir));
			const now = options.now ?? (() => Date.now());
			// 观测双通道：log（快速 grep）+ reporter（trace_custom 行，灰度分析脚本直读）
			const report = (observation: CompactionGuardObservation): void => {
				logObservation(currentSessionId, observation);
				options.reporter?.(currentSessionId, observation);
			};
			const serialize = options.serialize ?? sdkSerializer();

			let currentSessionId = "";
			let state: GuardState = createGuardState();
			/** 已发起、还没收到 `session_compact`/`session_compact_failed` 的那次 */
			let pending: Attempt | null = null;
			/** 压缩已完成、在等「下一次非 null 用量」来判效果（刚压缩完 tokens 恒为 null） */
			let awaitingOutcome: Attempt | null = null;
			/** 最近一次压缩之后是否已经出现真实 usage（决定 percentBasis） */
			let hasUsageSinceCompaction = false;

			/**
			 * 会话 id 惰性解析：观测行要带 id，但**不能依赖 `session_start` 一定发过**
			 * （`createAgentSession` 的宿主不一定发它——集成测试里实测只有 agent/turn 系列事件）。
			 * 工厂是每会话一份闭包，所以这里的缓存不会串会话。
			 */
			const sessionIdOf = (ctx: { sessionManager: { getSessionId(): string } }): string => {
				try {
					currentSessionId = ctx.sessionManager.getSessionId();
				} catch {
					// 取不到就沿用上一次的（观测行仍可读，不影响任何行为）
				}
				return currentSessionId;
			};

			// --- 生命周期（重置状态 + 记一行启用日志；不承担「是否初始化」的职责） ---
			pi.on("session_start", async (_event, ctx) => {
				try {
					sessionIdOf(ctx);
					state = createGuardState();
					pending = null;
					awaitingOutcome = null;
					hasUsageSinceCompaction = false;
					const config = getConfig();
					if (config.enabled) {
						log.info("compaction guard 已启用", { sessionId: shortId(currentSessionId), ...config });
					}
				} catch (err) {
					log.error("compaction-guard session_start 处理异常", { error: messageOf(err) });
				}
			});

			// --- percent 口径追踪：真实 usage 出现即记账；压缩后作废（spec D6 的 percentBasis） ---
			pi.on("message_end", (event) => {
				try {
					const message = event.message as unknown as {
						role?: string;
						usage?: Record<string, number>;
						stopReason?: string;
					};
					if (message.role !== "assistant") return;
					if (message.stopReason === "aborted" || message.stopReason === "error") return;
					const total = usageTotal(message.usage);
					if (total > 0) hasUsageSinceCompaction = true;
				} catch {
					// 纯记账，出问题也不影响任何事
				}
			});

			// --- 触发（每个 agent 周期结束、且不会再有自动重试/压缩/排队续跑时） ---
			pi.on("agent_settled", (_event, ctx) => {
				// **必须同步**（spec D2）：读用量 → 判阈值 → ctx.compact() 之间不得 await。
				// `ctx.compact()` 内部第一步就是 `await this.abort()`；一旦让出事件循环，
				// 用户刚发的新 prompt 可能插进来被这次 abort 干掉（白丢一条用户消息）。
				try {
					sessionIdOf(ctx);
					const config = getConfig();
					if (!config.enabled) return;
					const usage = ctx.getContextUsage();
					const percentBasis: CompactionPercentBasis = hasUsageSinceCompaction ? "usage" : "estimate";

					// 1) 先结算上一次压缩的效果（spec D6：只能在拿到非 null 用量时判）
					if (awaitingOutcome && usage && usage.tokens !== null && usage.contextWindow > 0) {
						const attempt = awaitingOutcome;
						awaitingOutcome = null;
						const percentNow = (usage.tokens / usage.contextWindow) * 100;
						const judged = judgeOutcome({
							percentBefore: attempt.percent,
							percentNow,
							thresholdPct: config.thresholdPct,
						});
						state = applyOutcome(state, judged.outcome);
						report({
							phase: "settled",
							source: "guard",
							outcome: judged.outcome,
							percent: percentNow,
							percentBasis,
							tokensBefore: attempt.tokensBefore,
							estimatedBefore: attempt.tokensBefore,
							estimatedAfter: usage.tokens,
							contextWindow: usage.contextWindow,
							detail: `下降 ${judged.dropPct.toFixed(1)} 个百分点 · 连续无效 ${state.ineffectiveStreak} 次`,
						});
					}

					// 2) 判是否触发
					const decision = decideTrigger({ config, usage, state, now: now() });
					if (!decision.trigger) {
						log.debug("compaction guard 不触发", {
							sessionId: shortId(currentSessionId),
							reason: decision.reason,
							percent: decision.percent === null ? null : Math.round(decision.percent * 10) / 10,
						});
						return;
					}
					state = recordTrigger(state, now());
					pending = { percent: decision.percent, tokensBefore: decision.tokens };
					report({
						phase: "trigger",
						reason: "threshold-pct",
						source: "guard",
						percent: decision.percent,
						percentBasis,
						tokensBefore: decision.tokens,
						contextWindow: decision.contextWindow,
					});
					ctx.compact();
				} catch (err) {
					log.error("compaction guard 触发路径异常，本轮跳过", { error: messageOf(err) });
				}
			});

			// --- 收尾：压缩成功 / 失败（自研与 SDK 自己触发的都会到这两个事件） ---
			pi.on("session_compact", (event, ctx) => {
				try {
					sessionIdOf(ctx);
					const mine = pending !== null;
					if (mine && pending) {
						// 效果判定要等下一次真实用量；这里只交接记账
						awaitingOutcome = pending;
						pending = null;
					} else {
						// SDK 自己触发的压缩（手动/SDK 阈值/溢出恢复）：给退避一次重启机会，冷却清零
						state = { ...applyOutcome(state, "ok"), lastTriggerAt: null };
					}
					hasUsageSinceCompaction = false;
					report({
						phase: "settled",
						reason: event.reason,
						source: mine ? "guard" : "sdk",
						outcome: "ok",
						tokensBefore: event.compactionEntry.tokensBefore,
					});
				} catch (err) {
					log.error("compaction guard session_compact 处理异常", { error: messageOf(err) });
				}
			});

			pi.on("session_compact_failed", (event, ctx) => {
				try {
					sessionIdOf(ctx);
					const mine = pending !== null;
					pending = null;
					// spec D6 两条阶梯：失败走 failed 阶梯（不封顶，倍数最多 ×8），
					// **不**计入 ineffective——瞬时失败不是「压缩没用」的证据（那会把护栏永久关掉）
					if (mine) state = applyOutcome(state, "failed");
					report({
						phase: "settled",
						reason: event.reason,
						source: mine ? "guard" : "sdk",
						outcome: event.aborted ? "aborted" : "failed",
						detail: event.errorMessage,
					});
				} catch (err) {
					log.error("compaction guard session_compact_failed 处理异常", { error: messageOf(err) });
				}
			});

			// --- 摘要输入有界（层 1 降级 + 层 2 硬上限，spec D3） ---
			pi.on("session_before_compact", (event, ctx) => {
				// 同步改 `preparation`（与 SDK 默认摘要路径同对象，spec §2），不 await
				try {
					sessionIdOf(ctx);
					const config = getConfig();
					const preparation = event.preparation;
					if (!config.enabled) return undefined;

					const model = ctx.model;
					const cap = hardCapTokens({
						contextWindow: model?.contextWindow ?? 0,
						reserveTokens: preparation.settings?.reserveTokens ?? 0,
						maxTokens: model?.maxTokens,
						hardCapRatio: config.hardCapRatio,
					});
					const boundOptions = {
						cap,
						protectTurns: config.protectTurns,
						toolResultChars: config.toolResultChars,
						serialize,
					};

					// split turn 会**发两次**摘要请求（历史 + 回合前缀），两份都必须过同一个有界函数
					const historyInput = preparation.messagesToSummarize as unknown as GuardMessage[];
					const prefixInput = preparation.turnPrefixMessages as unknown as GuardMessage[];
					const history = boundMessages(historyInput, boundOptions);
					const prefix = prefixInput.length > 0 ? boundMessages(prefixInput, boundOptions) : undefined;

					preparation.messagesToSummarize = history.messages as never;
					if (prefix) preparation.turnPrefixMessages = prefix.messages as never;

					const stats = mergeStats(history.stats, prefix?.stats);
					const detail = [
						`history ${history.stats.estimatedBefore}→${history.stats.estimatedAfter}`,
						prefix ? `prefix ${prefix.stats.estimatedBefore}→${prefix.stats.estimatedAfter}` : undefined,
						// M1：收不下去时交回的是「已知最小的那一版」，不是原样
						stats.oversized > 0 ? `单条超 cap ${stats.oversized} 条（已交回最小版本）` : undefined,
					]
						.filter((line) => line !== undefined)
						.join(" · ");
					report({
						phase: "bound",
						reason: event.reason,
						source: pending !== null ? "guard" : "sdk",
						splitTurn: preparation.isSplitTurn,
						tokensBefore: preparation.tokensBefore,
						cap,
						estimatedBefore: stats.estimatedBefore,
						estimatedAfter: stats.estimatedAfter,
						measure: stats.measure,
						capRounds: stats.capRounds,
						degradedMessages: stats.degradedMessages,
						droppedMessages: stats.droppedMessages,
						detail,
						...(stats.withinCap ? {} : { outcome: "cap-unreachable" as const }),
					});
				} catch (err) {
					// 出错就原样返回，让 SDK 走默认路径（绝不因为本扩展让压缩整体失败）
					log.error("compaction guard 有界化失败，原样放行", { error: messageOf(err) });
					report({ phase: "bound", outcome: "hook-error", detail: messageOf(err) });
				}
				return undefined;
			});
		},
	};
}

interface MergedStats extends Omit<CompactionBoundStats, "messageCount" | "cap" | "oversizedMessages"> {
	oversized: number;
}

/** 两份请求各自的统计合并成一行观测（口径：`exact` 优先——任一边做了整体估算就按整体报） */
function mergeStats(history: CompactionBoundStats, prefix?: CompactionBoundStats): MergedStats {
	if (!prefix) {
		return {
			estimatedBefore: history.estimatedBefore,
			estimatedAfter: history.estimatedAfter,
			measure: history.measure,
			capRounds: history.capRounds,
			degradedMessages: history.degradedMessages,
			droppedMessages: history.droppedMessages,
			oversized: history.oversizedMessages,
			withinCap: history.withinCap,
		};
	}
	return {
		estimatedBefore: history.estimatedBefore + prefix.estimatedBefore,
		estimatedAfter: history.estimatedAfter + prefix.estimatedAfter,
		measure: history.measure === "exact" || prefix.measure === "exact" ? "exact" : "cheap",
		capRounds: history.capRounds + prefix.capRounds,
		degradedMessages: history.degradedMessages + prefix.degradedMessages,
		droppedMessages: history.droppedMessages + prefix.droppedMessages,
		oversized: history.oversizedMessages + prefix.oversizedMessages,
		withinCap: history.withinCap && prefix.withinCap,
	};
}

function usageTotal(usage: Record<string, number> | undefined): number {
	if (!usage) return 0;
	if (typeof usage.totalTokens === "number") return usage.totalTokens;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** 短 id 只为人肉 grep：uuidv7 的时间前缀在同一次运行内相同，**取尾部**才有区分度 */
const shortId = (sessionId: string): string => (sessionId.length > 8 ? sessionId.slice(-8) : sessionId);

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** log 通道（trace_custom 由 reporter 另写；两处都带 sessionId 便于 grep 单会话） */
function logObservation(sessionId: string, observation: CompactionGuardObservation): void {
	log.info("compaction_guard", { sessionId: shortId(sessionId), ...observation });
}
