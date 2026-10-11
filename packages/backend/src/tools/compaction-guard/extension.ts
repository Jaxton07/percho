import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../log";
import { boundMessages } from "./bound";
import { readCompactionGuardConfig } from "./config";
import type { GuardState } from "./guard";
import { applyOutcome, createGuardState, decideTrigger, judgeOutcome, recordTrigger } from "./guard";
import type { CompactionGuardConfig, CompactionGuardObservation, GuardMessage } from "./types";

const log = createLogger("compaction-guard");

/**
 * 压缩护栏 — 内置扩展（spec: .local/agent-work/spec/compaction-bounded.md）。
 *
 * 本扩展做三件事：
 * 1. **百分比触发**（`agent_settled` 内**同步**判定 + `ctx.compact()`，spec D1/D2）——
 *    替代 SDK「窗口 − 16384」那条绝对余量线（1M 窗口上 = 98.4%，等于永不触发）。
 * 2. **摘要输入有界**（`session_before_compact`，spec D3）——层 1 降级 + 层 2 硬上限。
 *    **阶段 1：只量体积、不改输入**（层 1/层 2 在阶段 2 落地）。
 * 3. **观测**（spec D6）：trigger / bound / settled 三个相位各记一行 `compaction_guard` trace。
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
			let initialized = false;
			let state: GuardState = createGuardState();
			/** 已发起、还没收到 `session_compact`/`session_compact_failed` 的那次 */
			let pending: Attempt | null = null;
			/** 压缩已完成、在等「下一次非 null 用量」来判效果（刚压缩完 tokens 恒为 null） */
			let awaitingOutcome: Attempt | null = null;

			// --- 生命周期 ---
			pi.on("session_start", async (_event, ctx) => {
				try {
					initialized = true;
					currentSessionId = ctx.sessionManager.getSessionId();
					state = createGuardState();
					pending = null;
					awaitingOutcome = null;
					const config = getConfig();
					if (config.enabled) {
						log.info("compaction guard 已启用", { sessionId: currentSessionId.slice(0, 8), ...config });
					}
				} catch (err) {
					// 初始化失败 → 整个会话不干预（SDK 默认路径原样）
					initialized = false;
					log.error("compaction-guard session_start 失败，本会话不干预", { error: messageOf(err) });
				}
			});

			// --- 触发（每个 agent 周期结束、且不会再有自动重试/压缩/排队续跑时） ---
			pi.on("agent_settled", (_event, ctx) => {
				// **必须同步**（spec D2）：读用量 → 判阈值 → ctx.compact() 之间不得 await。
				// `ctx.compact()` 内部第一步就是 `await this.abort()`；一旦让出事件循环，
				// 用户刚发的新 prompt 可能插进来被这次 abort 干掉（白丢一条用户消息）。
				try {
					if (!initialized) return;
					const config = getConfig();
					if (!config.enabled) return;
					const usage = ctx.getContextUsage();

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
							sessionId: currentSessionId.slice(0, 8),
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
						percent: decision.percent,
						tokensBefore: decision.tokens,
						contextWindow: decision.contextWindow,
					});
					ctx.compact();
				} catch (err) {
					log.error("compaction guard 触发路径异常，本轮跳过", { error: messageOf(err) });
				}
			});

			// --- 收尾：压缩成功 / 失败（自研与 SDK 自己触发的都会到这两个事件） ---
			pi.on("session_compact", (event) => {
				try {
					const mine = pending !== null;
					if (mine && pending) {
						// 效果判定要等下一次真实用量；这里只交接记账
						awaitingOutcome = pending;
						pending = null;
					} else {
						// SDK 自己触发的压缩（手动/SDK 阈值/溢出恢复）：给退避一次重启机会，冷却清零
						state = { ...applyOutcome(state, "ok"), lastTriggerAt: null };
					}
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

			pi.on("session_compact_failed", (event) => {
				try {
					const mine = pending !== null;
					pending = null;
					// 连续失败与「连续无效」共用同一退避阶梯：连续失败时不该猛打（spec D6 + §5）
					if (mine) state = applyOutcome(state, "ineffective");
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

			// --- 摘要输入有界（阶段 1：只观测，不改输入） ---
			pi.on("session_before_compact", (event) => {
				try {
					const config = getConfig();
					const preparation = event.preparation;
					const history = preparation.messagesToSummarize as unknown as GuardMessage[];
					const prefix = preparation.turnPrefixMessages as unknown as GuardMessage[];
					// 阶段 2 接真实 cap（spec D3：min(hardCapRatio × 窗口, 窗口 − summaryMaxOut − 2048)）；
					// 阶段 1 只量体积，故用「不介入」的 cap。
					const boundOptions = {
						cap: Number.POSITIVE_INFINITY,
						protectTurns: config.protectTurns,
						toolResultChars: config.toolResultChars,
						serialize,
					};
					const historyBound = boundMessages(history, boundOptions);
					const prefixBound = prefix.length > 0 ? boundMessages(prefix, boundOptions) : undefined;
					const estimatedBefore =
						historyBound.stats.estimatedBefore + (prefixBound?.stats.estimatedBefore ?? 0);
					const estimatedAfter = historyBound.stats.estimatedAfter + (prefixBound?.stats.estimatedAfter ?? 0);
					report({
						phase: "bound",
						reason: event.reason,
						splitTurn: preparation.isSplitTurn,
						tokensBefore: preparation.tokensBefore,
						estimatedBefore,
						estimatedAfter,
						degradedMessages:
							historyBound.stats.degradedMessages + (prefixBound?.stats.degradedMessages ?? 0),
						droppedMessages: historyBound.stats.droppedMessages + (prefixBound?.stats.droppedMessages ?? 0),
						// 阶段 2 起这里还会把有界化结果赋值回 preparation（当前未生效）
						detail: `history ${historyBound.stats.estimatedBefore} → ${historyBound.stats.estimatedAfter}`,
					});
				} catch (err) {
					log.error("compaction guard 体积统计失败，原样放行", { error: messageOf(err) });
				}
				return undefined;
			});
		},
	};
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** log 通道（trace_custom 由 reporter 另写；两处都带 sessionId 便于 grep 单会话） */
function logObservation(sessionId: string, observation: CompactionGuardObservation): void {
	log.info("compaction_guard", { sessionId: sessionId.slice(0, 8), ...observation });
}
