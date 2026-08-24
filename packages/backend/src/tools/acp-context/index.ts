/**
 * ACP 模型驱动上下文压缩（内置扩展）。
 *
 * 依赖 npm `acp-kernel`（钉 0.0.42，ESM-only，与 pi SDK 同形态 external 策略）。
 * 通过 pi 扩展 context 钩子在每次 LLM 调用前做压缩编排；模型经 compress 工具
 * 定向圈定范围写摘要，压缩发生在 turn 中间、任务循环不中断（spec：
 * .local/docs/design/spec/acp-context.md）。
 */

export type { BridgeEntry } from "./bridge";
export { alignOriginals, coreOutToAgentMessages, entriesToCoreMessages, projectEntries } from "./bridge";
export { clearAcpEnabledCache, readAcpEnabled, writeAcpEnabled } from "./config";
export type { AcpExtensionOptions, AcpStore } from "./extension";
export { ACP_EMERGENCY_FALLBACK_PCT, buildAcpSystemPrompt, makeAcpExtension } from "./extension";
export { buildNudgeMessage, nudgeTextFor, nudgeTurnKey } from "./nudge";
export type { PersistedAcpState } from "./store";
export { acpStateFile, hydrateAcpState, loadAcpState, resetAcpState, saveAcpState } from "./store";
export {
	compressParams,
	decompressParams,
	makeAcpTools,
	prepareCompressArguments,
	searchContextParams,
} from "./tools";
