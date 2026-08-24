import type { CoreMessage } from "acp-kernel";
import type { ContentBlock, RawMessage } from "../../session/messages";

/**
 * ACP 桥接（T3）：pi 会话条目 ↔ acp-kernel CoreMessage 双向转换。
 *
 * 设计依据（阶段 0 冒烟 V1 实证）：
 * - 稳定 id 用 entry.id（8 hex，永不含 `#`）；assistant 多工具调用消息拆 `id#callId`
 *   （压缩范围可覆盖部分工具调用，回转时按 baseId 合并、只保留幸存 callId 的块）
 * - originals 优先取 event.messages（emitContext 起手 structuredClone 的副本）按
 *   index+role 与「消息投影」对齐——保住上游 context 钩子（视觉代理 image→文本替换）
 *   的变换；对齐失败回退 entries 派生（bcp 生产路径，安全降级）
 * - `<acp tokens=..>mNNNNN</acp>` 标签只在 LLM 请求里存活（kernel render-refs 注入
 *   core 视图），回转时注入原消息最后 text block；entries 永不含标签，天然幂等
 * - thinking block 不进 core 视图（bcp 同款：transient 推理不参与压缩/计数）
 */

/** `<acp tokens="1.2K" type="tool:bash">m00042</acp>` 前缀标签（kernel render-refs 注入） */
const ACP_TAG_RE = /^<acp[^>]*>m\d{1,5}<\/acp>\n?/;

function stripTag(text: string): string {
	return text.replace(ACP_TAG_RE, "");
}

function extractText(content: string | ContentBlock[] | undefined): string {
	if (typeof content === "string") return stripTag(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(stripTag(block.text));
	}
	return parts.join("\n");
}

function stringifyArgs(args: Record<string, unknown> | undefined): string {
	if (args == null) return "";
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

function toolCallsOf(content: string | ContentBlock[] | undefined): Array<{
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}> {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	for (const block of content) {
		if (block.type === "toolCall" && typeof block.name === "string") {
			calls.push({
				id: block.id ?? "",
				name: block.name,
				arguments: (block.arguments ?? {}) as Record<string, unknown>,
			});
		}
	}
	return calls;
}

/** 会话条目（结构最小投影；避免 import SDK 类型进纯函数模块） */
export interface BridgeEntry {
	type: string;
	id: string;
	message?: RawMessage;
	content?: string | ContentBlock[];
	customType?: string;
	summary?: string;
	/** custom_message 的 UI 展示开关（fallback 路径透传，防 [context] 提醒渲染进消息流） */
	display?: boolean;
	/** custom_message 的结构化详情（fallback 路径透传） */
	details?: unknown;
}

/** entries → 消息投影（与 SDK sessionEntryToContextMessages 的可见消息一一对应，对齐用） */
export function projectEntries(entries: BridgeEntry[]): Array<{ id: string; message: RawMessage }> {
	const out: Array<{ id: string; message: RawMessage }> = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			out.push({ id: entry.id, message: entry.message });
		} else if (entry.type === "custom_message") {
			out.push({
				id: entry.id,
				message: {
					role: "custom",
					customType: entry.customType ?? "acp",
					content: entry.content ?? "",
					display: entry.display ?? false,
					details: entry.details,
					timestamp: Date.now(),
				},
			});
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.summary) {
			out.push({
				id: entry.id,
				message: { role: entry.type, content: entry.summary, timestamp: Date.now() },
			});
		}
	}
	return out;
}

/** assistant 消息投影：多工具调用拆分（单条保留正文，多条各带参数文本） */
function projectAssistant(entry: BridgeEntry): CoreMessage[] {
	const message = entry.message as RawMessage;
	const id = entry.id;
	const calls = toolCallsOf(message.content);
	const text = extractText(message.content);
	if (calls.length === 0) {
		// 空文本且无工具调用的 assistant（纯 thinking 等）不投影（bcp 同款；回转时随之从视图消失）
		if (!text.trim()) return [];
		return [{ id, role: "assistant", contentType: "text", text }];
	}
	const single = calls[0];
	if (calls.length === 1 && single) {
		const argStr = stringifyArgs(single.arguments);
		const combined = argStr && text ? `${text}\n${argStr}` : argStr || text;
		return [
			{
				id,
				role: "assistant",
				contentType: "tool-call",
				toolName: single.name,
				toolCallId: single.id,
				text: combined,
			},
		];
	}
	// 正文挂第一条拆分消息（R2：否则正文不进 core 视图——不可压且估算漏算）；
	// 回转合并取 original 完整消息，视图侧的正文副本不影响输出
	return calls.map((call, i) => ({
		id: `${id}#${call.id}`,
		role: "assistant" as const,
		contentType: "tool-call" as const,
		toolName: call.name,
		toolCallId: call.id,
		text: i === 0 && text ? `${text}\n${stringifyArgs(call.arguments)}` : stringifyArgs(call.arguments),
	}));
}

/** entries → acp CoreMessage[]（kernel processTurn 入参） */
export function entriesToCoreMessages(entries: BridgeEntry[]): CoreMessage[] {
	const out: CoreMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "custom_message") {
			const text = extractText(entry.content);
			if (text.length > 0) out.push({ id: entry.id, role: "user", contentType: "text", text });
			continue;
		}
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.summary) {
			out.push({ id: entry.id, role: "user", contentType: "text", text: entry.summary });
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		switch (message.role) {
			case "user":
				out.push({ id: entry.id, role: "user", contentType: "text", text: extractText(message.content) });
				break;
			case "assistant":
				out.push(...projectAssistant(entry));
				break;
			case "toolResult":
				out.push({
					id: entry.id,
					role: "tool",
					contentType: "tool-result",
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					text: extractText(message.content),
				});
				break;
			default: {
				// bashExecution / custom 等其它角色：投影为 user 文本（保留在 kernel 视图里可被压缩）
				const text =
					extractText(message.content) ||
					(typeof (message as { command?: unknown }).command === "string"
						? String((message as { command?: unknown }).command)
						: "");
				if (text.trim()) out.push({ id: entry.id, role: "user", contentType: "text", text });
				break;
			}
		}
	}
	return out;
}

/**
 * event.messages ↔ 消息投影按 index+role 对齐：originals 取 transform 链上游处理过的
 * 消息对象（保住视觉代理等上游钩子的变换）；失配回退 entries 派生。
 */
export function alignOriginals(
	entries: BridgeEntry[],
	eventMessages: RawMessage[],
): { originals: Map<string, RawMessage>; aligned: boolean } {
	const projected = projectEntries(entries);
	const originals = new Map<string, RawMessage>();
	if (eventMessages.length === projected.length) {
		let aligned = true;
		for (let i = 0; i < projected.length; i++) {
			const live = eventMessages[i];
			const proj = projected[i];
			if (!live || !proj || live.role !== proj.message.role) {
				aligned = false;
				break;
			}
			originals.set(proj.id, live);
		}
		if (aligned) return { originals, aligned: true };
	}
	originals.clear();
	for (const p of projected) originals.set(p.id, p.message);
	return { originals, aligned: false };
}

/** `<acp>` 标签注入原消息最后一个 text block（模型需要看到 ref 坐标系） */
function withTag(original: RawMessage, tag: string | null): RawMessage {
	if (!tag) return original;
	if (typeof original.content === "string") {
		return { ...original, content: `${original.content.replace(/\n*$/, "")}\n\n${tag}` };
	}
	if (Array.isArray(original.content)) {
		const blocks: ContentBlock[] = original.content.map((b) => ({ ...b }));
		for (let i = blocks.length - 1; i >= 0; i--) {
			const block: ContentBlock | undefined = blocks[i];
			if (block && block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
				block.text = `${block.text.replace(/\n*$/, "")}\n\n${tag}`;
				return { ...original, content: blocks };
			}
		}
		return { ...original, content: [...blocks, { type: "text", text: tag }] };
	}
	return { ...original, content: [{ type: "text", text: tag }] };
}

/** 核心视图文本（剥标签）与原文不同 = emergency-truncate 动过 → 用核心文本重建正文 */
function rebuildBodyFromCore(original: RawMessage, coreBody: string, tag: string): RawMessage {
	const text = `${coreBody.replace(/\s+$/, "")}\n\n${tag}`;
	if (typeof original.content === "string") return { ...original, content: text };
	if (Array.isArray(original.content)) {
		const nonText = original.content.filter((b) => b.type !== "text");
		return { ...original, content: [...nonText, { type: "text", text }] };
	}
	return { ...original, content: [{ type: "text", text }] };
}

function coreBody(core: CoreMessage): { tag: string | null; body: string } {
	const text = core.text ?? "";
	const tag = text.match(ACP_TAG_RE)?.[0] ?? null;
	return { tag, body: tag ? stripTag(text) : text };
}

/**
 * processTurn 输出 → pi AgentMessage[]：
 * - 摘要消息（acp_summary_*）→ CustomMessage（customType:"acp-summary"，display:false，
 *   details 带 blockId；convertToLlm 把 custom 映射为 user role，模型可见）
 * - 保留消息按 id 映射回 originals（保 image block / thoughtSignature 等完整结构），
 *   多工具调用拆分按 baseId 合并、只保留幸存 callId 的 toolCall 块
 * - 视图文本与原文的差异（emergency-truncate）传播回原消息
 * - `<acp>` 标签注入最后 text block
 */
export function coreOutToAgentMessages(
	coreOut: CoreMessage[],
	originalById: Map<string, RawMessage>,
): RawMessage[] {
	const out: RawMessage[] = [];
	const emittedSplit = new Set<string>();
	for (const core of coreOut) {
		if (core.id.startsWith("acp_summary_")) {
			const blockId = core.id.slice("acp_summary_".length);
			out.push({
				role: "custom",
				customType: "acp-summary",
				content: core.text ?? "",
				display: false,
				details: { blockId },
				timestamp: Date.now(),
			});
			continue;
		}
		const { tag, body } = coreBody(core);
		const hashIdx = core.id.indexOf("#");
		if (hashIdx < 0) {
			const original = originalById.get(core.id);
			if (!original) continue;
			// 文本差异仅对 toolResult 有意义（emergency-truncate 只动 tool-result）：
			// assistant 的 core 文本 = 正文+参数串（构造性不同），比对会误触发重建丢掉 toolCall 块
			if (original.role === "toolResult") {
				const originalBody = extractText(original.content);
				if (body.trimEnd() !== originalBody.trimEnd() && body.length > 0) {
					out.push(rebuildBodyFromCore(original, body, tag ?? ""));
					continue;
				}
			}
			out.push(withTag(original, tag));
			continue;
		}
		const baseId = core.id.slice(0, hashIdx);
		if (emittedSplit.has(baseId)) continue;
		emittedSplit.add(baseId);
		const original = originalById.get(baseId);
		if (!original) continue;
		const survivingCallIds = new Set(
			coreOut
				.filter((c) => c.id.startsWith(`${baseId}#`))
				.map((c) => c.toolCallId)
				.filter((id): id is string => !!id),
		);
		const blocks = Array.isArray(original.content) ? original.content : [];
		const filtered = blocks.filter(
			(b) => b.type !== "toolCall" || survivingCallIds.has((b as ContentBlock).id ?? ""),
		);
		out.push(withTag({ ...original, content: filtered }, tag));
	}
	return out;
}
