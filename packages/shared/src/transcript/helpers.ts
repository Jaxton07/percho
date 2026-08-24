import type { ImageInput } from "../session";
import type { ActivityEntry, StreamingState } from "./types";

/** reducer 内部共用工具：本地 id 生成、事件载荷解析、流式容器构造 */

let nextMessageId = 0;
export function newMessageId(): string {
	return `m${nextMessageId++}`;
}

let nextToolKey = 0;
export function newToolKey(): string {
	return `t${nextToolKey++}`;
}

let nextSubagentKey = 0;
export function newSubagentKey(): string {
	return `s${nextSubagentKey++}`;
}

export function emptyStreaming(): StreamingState {
	return {
		id: newMessageId(),
		text: "",
		rawText: "",
		thinking: "",
		tools: [],
		pendingImages: [],
		subagentRuns: [],
		subagentByToolCallId: {},
		activeToolIndex: -1,
		toolByContentIndex: {},
		rawToolOutputs: {},
		activity: [],
		textBlockIndex: null,
	};
}

export function parseArgs(raw: unknown): string {
	if (typeof raw !== "string") return JSON.stringify(raw ?? {});
	try {
		const parsed = JSON.parse(raw);
		return JSON.stringify(parsed, null, 0);
	} catch {
		return raw;
	}
}

/** 增量消息里按 contentIndex 找工具名（向后扫描最近的 toolCall 块） */
export function toolNameFromPartial(partial: unknown, contentIndex: number): string {
	const content = (partial as { content?: Array<{ type?: string; name?: string }> } | undefined)?.content;
	const block = content?.[contentIndex];
	if (block?.type === "toolCall" && block.name) return block.name;
	for (let i = contentIndex - 1; i >= 0; i--) {
		const prev = content?.[i];
		if (prev?.type === "toolCall" && prev.name) return prev.name;
	}
	return "tool";
}

/** thinking 按 content block 累积；同一块原地更新，首次到达按顺序追加。 */
export function updateThinkingActivity(
	activity: ActivityEntry[],
	contentIndex: number,
	append: (text: string) => string,
): ActivityEntry[] {
	const id = `h${contentIndex}`;
	const existing = activity.find((entry) => entry.id === id);
	if (!existing) return [...activity, { id, kind: "thinking", text: append("") }];
	return activity.map((entry) =>
		entry.id === id && entry.kind === "thinking" ? { ...entry, text: append(entry.text) } : entry,
	);
}

export function updateToolActivity(
	activity: ActivityEntry[],
	contentIndex: number,
	append: (args: string) => string,
): ActivityEntry[] {
	const id = `c${contentIndex}`;
	return activity.map((entry) =>
		entry.id === id && entry.kind === "tool" ? { ...entry, args: append(entry.args) } : entry,
	);
}

export function findLastIndex<T>(arr: readonly T[], predicate: (item: T) => boolean): number {
	for (let i = arr.length - 1; i >= 0; i--) {
		const item = arr[i];
		if (item && predicate(item)) return i;
	}
	return -1;
}

/** 工具执行增量（partialResult）里的输出文本：string 直取，对象取 output/text 字段 */
export function extractExecutionDelta(partialResult: unknown): string | null {
	if (partialResult == null) return null;
	if (typeof partialResult === "string") return partialResult;
	const partial = partialResult as Record<string, unknown>;
	const output = partial.output;
	if (typeof output === "string" && output.length > 0) return output;
	const text = partial.text;
	if (typeof text === "string" && text.length > 0) return text;
	return null;
}

/** show_image 工具结果 → 待发图片（兼容旧单图 details.image；结构不符返回 null） */
export function extractShowImage(result: unknown): { images: ImageInput[]; paths: string[] } | null {
	const details = (result as { details?: unknown } | null | undefined)?.details;
	const d = details as { paths?: unknown; images?: unknown; path?: unknown; image?: unknown } | undefined;
	const toImage = (raw: unknown): ImageInput | null => {
		const img = raw as { data?: unknown; mimeType?: unknown } | undefined;
		if (typeof img?.data !== "string" || typeof img?.mimeType !== "string") return null;
		return { data: img.data, mimeType: img.mimeType };
	};
	const toPaths = (raw: unknown): string[] =>
		Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
	if (Array.isArray(d?.images)) {
		const images = d.images.map(toImage).filter((img): img is ImageInput => img !== null);
		return images.length > 0 ? { images, paths: toPaths(d.paths) } : null;
	}
	const legacy = toImage(d?.image);
	if (!legacy) return null;
	return { images: [legacy], paths: typeof d?.path === "string" ? [d.path] : [] };
}

/** edit 工具结果 → unified patch（details.patch 由 SDK edit-diff 产出；结构不符/非字符串返回 null） */
export function extractEditPatch(result: unknown): string | null {
	const details = (result as { details?: unknown } | null | undefined)?.details;
	const patch = (details as { patch?: unknown } | undefined)?.patch;
	return typeof patch === "string" && patch.length > 0 ? patch : null;
}
