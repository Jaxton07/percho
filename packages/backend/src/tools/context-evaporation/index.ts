/**
 * 上下文蒸发（内置扩展）：可再生工具输出按水位线蒸发为自带恢复指令的 stub。
 *
 * 模块分层（arch §1）：
 * - types/estimate/evaporate：纯函数核心，零 SDK/零仓库 import（replay --core 同构共用）
 * - config：配置链路（单一决策 key + 单一写者原子写 + 二态派生读）
 * - extension：InlineExtension 接线（context 钩子 / session_start / session_compact）
 *
 * 行为规则唯一权威：.local/agent-work/spec/context-evaporation.md（spec v2）。
 */

export {
	clearEvapConfigCache,
	readContextManagerMode,
	readEvapConfig,
	writeContextManagerMode,
} from "./config";
export { IMAGE_STUB_TEXT, inspectParts } from "./evaporate";
export type { EvapExtensionOptions } from "./extension";
export { makeEvapExtension, reportEvapBatch } from "./extension";
export {
	createEvapState,
	DEFAULT_EVAP_CONFIG,
	type EvapBatchInfo,
	type EvapConfig,
	type EvapState,
	type EvapWireMessage,
} from "./types";
