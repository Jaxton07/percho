/**
 * 会话 transcript reducer barrel：实现拆在本目录：types / helpers / reducer / mapping，入口即本文件（原 desktop stores/transcript-reducer.ts，V2 下沉 shared 供 lan-web 复用）。
 * - types.ts    UI 消息/流式累积/会话状态类型 + emptyTranscript
 * - helpers.ts  本地 id 生成、事件载荷解析（reducer 内部共用）
 * - reducer.ts  reduceEvent（pi 事件 → UI 状态，纯函数）
 * - mapping.ts  messagesToUIMessages（历史消息回放映射）
 */

export { buildChatRows, type ChatRow, isAgentWorking, type MetaItem } from "./chat-rows";
export { messagesToUIMessages } from "./mapping";
export {
	categoryOf,
	dotsFromItems,
	type MetaDot,
	type SummarySegment,
	summarizeCategories,
	type ToolCategory,
} from "./meta-summary";
export { type PatchHunk, type PatchLine, parsePatch, patchStat } from "./parse-patch";
export { reduceEvent } from "./reducer";
export {
	type DiffSection,
	deriveTurnChanges,
	type TurnChanges,
	type TurnFileChange,
} from "./turn-files";
export { deriveTurnTimings, type TurnTiming } from "./turn-timings";
export {
	type ActivityEntry,
	type CompactionUiState,
	emptyTranscript,
	type RetryInfo,
	type SessionPhase,
	type SessionTranscriptState,
	type StreamingState,
	type SubagentRunUi,
	type UIMessage,
	type UIToolCall,
} from "./types";
