import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../log";
import { boundMessages } from "./bound";
import { readCompactionGuardConfig } from "./config";
import { hardCapTokens } from "./guard";
import type {
	CompactionBoundStats,
	CompactionGuardConfig,
	CompactionGuardObservation,
	GuardMessage,
} from "./types";

const log = createLogger("compaction-guard");

/** 摘要输入限制与观测。主动触发由请求前宿主策略负责，结束事件不再调用 compact。 */
export interface CompactionGuardExtensionOptions {
	agentDir: string;
	getConfig?: () => CompactionGuardConfig;
	reporter?: (sessionId: string, observation: CompactionGuardObservation) => void;
	serialize?: (messages: GuardMessage[]) => string;
}

export function sdkSerializer(): (messages: GuardMessage[]) => string {
	return (messages) => serializeConversation(convertToLlm(messages as never));
}

export function makeCompactionGuardExtension(options: CompactionGuardExtensionOptions): InlineExtension {
	return {
		name: "compaction-guard",
		factory: (pi) => {
			const getConfig = options.getConfig ?? (() => readCompactionGuardConfig(options.agentDir));
			const serialize = options.serialize ?? sdkSerializer();
			let currentSessionId = "";
			const sessionIdOf = (ctx: { sessionManager: { getSessionId(): string } }): string => {
				currentSessionId = ctx.sessionManager.getSessionId();
				return currentSessionId;
			};
			const report = (observation: CompactionGuardObservation): void => {
				logObservation(currentSessionId, observation);
				options.reporter?.(currentSessionId, observation);
			};
			pi.on("session_compact", (event, ctx) => {
				try {
					sessionIdOf(ctx);
					report({
						phase: "settled",
						source: "sdk",
						reason: event.reason,
						outcome: "ok",
						tokensBefore: event.compactionEntry.tokensBefore,
					});
				} catch (error) {
					log.error("压缩收尾观测失败", { error: messageOf(error) });
				}
			});
			pi.on("session_compact_failed", (event, ctx) => {
				try {
					sessionIdOf(ctx);
					report({
						phase: "settled",
						source: "sdk",
						reason: event.reason,
						outcome: event.aborted ? "aborted" : "failed",
						detail: event.errorMessage,
					});
				} catch (error) {
					log.error("压缩失败观测异常", { error: messageOf(error) });
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

					const model = event.model ?? ctx.model;
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
						source: "sdk",
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

/** 短 id 只为人肉 grep：uuidv7 的时间前缀在同一次运行内相同，**取尾部**才有区分度 */
const shortId = (sessionId: string): string => (sessionId.length > 8 ? sessionId.slice(-8) : sessionId);

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** log 通道（trace_custom 由 reporter 另写；两处都带 sessionId 便于 grep 单会话） */
function logObservation(sessionId: string, observation: CompactionGuardObservation): void {
	log.info("compaction_guard", { sessionId: shortId(sessionId), ...observation });
}
