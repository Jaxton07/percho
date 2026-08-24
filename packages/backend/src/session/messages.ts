import {
	parseSessionEntries,
	type SessionEntry,
	type SessionManager,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
	extractSubagentRuns,
	type ImageInput,
	parseExpandedSkillInvocation,
	type SessionMessage,
	type SessionToolCall,
	stripAcpReferenceTags,
} from "@percho/shared";

/**
 * pi 消息 → 中立 SessionMessage 的纯函数集（历史回放 / fork / recall / 导出共用）。
 * 不依赖 PiBackend 实例状态，可独立单测（见 test/recall.test.ts）。
 */

/** 消息 content 块（pi-ai 结构，仅读取所需字段） */
export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	data?: string;
	mimeType?: string;
}

export interface RawMessage {
	role: string;
	content?: string | ContentBlock[];
	toolCallId?: string;
	isError?: boolean;
	timestamp?: number;
	/** 工具结果结构化详情（show_image 在此带图片；模型不可见） */
	details?: unknown;
	/** toolResult 消息的工具名（getTodos 扫 todo 结果用） */
	toolName?: string;
	/** custom 消息的自定义类型（getTodos 扫 todo-reminder 恢复消息用） */
	customType?: string;
	/** custom 消息的 UI 展示开关（acp 摘要消息 display:false，不进消息流） */
	display?: boolean;
}

/** show_image toolResult.details → { images, paths }（兼容旧单图 { path, image } 形状；不符返回 null） */
function showImageFromDetails(details: unknown): { images: ImageInput[]; paths: string[] } | null {
	const d = details as { paths?: unknown; images?: unknown; path?: unknown; image?: unknown } | undefined;
	const toImage = (raw: unknown): ImageInput | null => {
		const img = raw as { data?: unknown; mimeType?: unknown } | undefined;
		if (typeof img?.data !== "string" || typeof img?.mimeType !== "string") return null;
		return { data: img.data, mimeType: img.mimeType };
	};
	if (Array.isArray(d?.images)) {
		const images = d.images.map(toImage).filter((img): img is ImageInput => img !== null);
		if (images.length === 0) return null;
		const paths = Array.isArray(d?.paths) ? d.paths.filter((p): p is string => typeof p === "string") : [];
		return { images, paths };
	}
	const legacy = toImage(d?.image);
	if (!legacy) return null;
	return { images: [legacy], paths: typeof d?.path === "string" ? [d.path] : [] };
}

export function blockText(content: string | ContentBlock[] | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text ?? "")
		.join("");
}

export function blockThinking(content: ContentBlock[] | undefined): string {
	return (content ?? [])
		.filter((c) => c.type === "thinking" && c.thinking)
		.map((c) => c.thinking ?? "")
		.join("");
}

export function blockToolCalls(
	content: ContentBlock[] | undefined,
): Array<{ tool: SessionToolCall; index: number }> {
	return (content ?? [])
		.map((c, index) => ({ c, index }))
		.filter(({ c }) => c.type === "toolCall" && c.id)
		.map(({ c, index }) => ({
			tool: {
				id: c.id ?? "",
				name: c.name ?? "tool",
				args: JSON.stringify(c.arguments ?? {}),
				output: "",
				isError: false,
			},
			index,
		}));
}

export function blockImages(content: string | ContentBlock[] | undefined): ImageInput[] {
	if (typeof content === "string") return [];
	return (content ?? [])
		.filter((c) => c.type === "image" && c.data)
		.map((c) => ({ data: c.data as string, mimeType: (c.mimeType as string) ?? "image/png" }));
}

/**
 * 解析撤回目标 user entry：entryId 直接校验（非 user 消息拒绝）；否则按 text（+timestamp
 * 优先比对）从分支尾部向前匹配最近一条 user 消息 entry（实时消息无 entryId 时兜底）。
 * 导出供单测：只依赖 SessionManager 的只读接口。
 */
export function resolveRecallEntryId(
	sm: Pick<SessionManager, "getEntry" | "getBranch">,
	ref: { entryId?: string; text?: string; timestamp?: number },
): string {
	if (ref.entryId) {
		const e = sm.getEntry(ref.entryId);
		if (!e) throw new Error("Recall target message not found");
		if (e.type !== "message" || (e.message as RawMessage).role !== "user") {
			throw new Error("Recall target is not a user message");
		}
		return ref.entryId;
	}
	if (ref.text !== undefined || ref.timestamp !== undefined) {
		const branch = sm.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e?.type !== "message") continue;
			const m = e.message as RawMessage;
			if (m.role !== "user") continue;
			// timestamp 同时给出时必须相等（毫秒碰撞军见，双重锚定防同文消息错配）
			if (ref.timestamp !== undefined && m.timestamp !== ref.timestamp) continue;
			if (ref.text !== undefined && blockText(m.content) !== ref.text) continue;
			return e.id;
		}
	}
	throw new Error("Recall target message not found");
}

/** 解析 fork 目标 entry：entryId 直接校验；否则按正文文本从分支尾部向前匹配 assistant 消息 */
export function resolveForkEntryId(
	sm: Pick<SessionManager, "getEntry" | "getBranch">,
	ref: { entryId?: string; text?: string },
): string {
	if (ref.entryId) {
		const e = sm.getEntry(ref.entryId);
		if (e) {
			// 只接受 assistant 消息作为 fork 点（与 text 分支同语义）；user/tool 条目拒绝防破坏分支结构（B7）
			if (e.type !== "message" || (e.message as RawMessage).role !== "assistant") {
				throw new Error("Fork target is not an assistant message");
			}
			return ref.entryId;
		}
		// entryId 未命中（如实时消息 entryId 缺失/已失效）→ 走 text 兑底
	}
	if (ref.text) {
		const branch = sm.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e?.type !== "message") continue;
			const m = e.message as RawMessage;
			if (m.role !== "assistant") continue;
			if (blockText(m.content) === ref.text) return e.id;
		}
	}
	throw new Error("Fork target message not found");
}

/**
 * 只读解析会话文件内容（LAN 历史会话透视用）：不走 SessionManager.open（可能迁移写盘），
 * 纯函数 parseSessionEntries + 从文件末尾（leaf tip）沿 parentId 回溯出当前分支。
 * 分支语义与 getBranch() 一致：只保留当前分支上的消息。
 */
export function readSessionMessagesFromContent(content: string): SessionMessage[] {
	const entries = parseSessionEntries(content);
	// 当前分支：从最后一条 entry（leaf）沿 parentId 回溯
	const byId = new Map<string, (typeof entries)[number]>();
	for (const entry of entries) {
		if (entry.type !== "session") byId.set(entry.id, entry);
	}
	const branch: (typeof entries)[number][] = [];
	let cursor = entries.length > 0 ? entries[entries.length - 1] : null;
	while (cursor && cursor.type !== "session") {
		branch.unshift(cursor);
		cursor = cursor.parentId ? (byId.get(cursor.parentId) ?? null) : null;
	}
	const raw = branch
		.filter((entry): entry is SessionMessageEntry => entry.type === "message")
		.map((entry) => entry.message);
	return toSessionMessages(raw);
}

/**
 * pi 消息 → 中立 SessionMessage 列表。
 * toolResult 消息单独出现（带 toolCallId），把输出回填到对应工具卡片。
 */
export function toSessionMessages(rawMessages: readonly unknown[]): SessionMessage[] {
	const out: SessionMessage[] = [];
	const toolById = new Map<string, SessionToolCall>();
	for (const raw of rawMessages as RawMessage[]) {
		if (raw.role === "user") {
			const sourceText = blockText(raw.content);
			const displayText = stripAcpReferenceTags(sourceText);
			const invocation = parseExpandedSkillInvocation(displayText);
			out.push({
				role: "user",
				text: invocation ? (invocation.args ?? "") : displayText,
				thinking: "",
				tools: [],
				images: blockImages(raw.content),
				timestamp: raw.timestamp ?? Date.now(),
				...(invocation || displayText !== sourceText
					? { ...(invocation ? { skill: { name: invocation.name, args: invocation.args } } : {}), sourceText }
					: {}),
			});
			continue;
		}
		if (raw.role === "assistant") {
			const content = Array.isArray(raw.content) ? raw.content : [];
			const toolBlocks = blockToolCalls(content);
			const tools = toolBlocks.map((b) => b.tool);
			for (const tool of tools) toolById.set(tool.id, tool);
			const sourceText = blockText(raw.content);
			const text = stripAcpReferenceTags(sourceText);
			// 正文后的工具（块序在首个 text 块之后，同 turn 内 text→toolCall 交错）：拆成独立 meta 消息
			// 排在正文消息之后，与 renderer finalizeStreaming 的拆分一致——否则渲染时会被倒挂到正文上方
			const textIndex = content.findIndex((c) => c?.type === "text" && c.text);
			const postBlocks = text && textIndex >= 0 ? toolBlocks.filter((b) => b.index > textIndex) : [];
			if (postBlocks.length > 0) {
				const preTools = toolBlocks.filter((b) => b.index < textIndex).map((b) => b.tool);
				const timestamp = raw.timestamp ?? Date.now();
				if (text || preTools.length > 0) {
					out.push({
						role: "assistant",
						text,
						thinking: blockThinking(content),
						tools: preTools,
						images: [],
						timestamp,
						...(text !== sourceText ? { sourceText } : {}),
					});
				}
				out.push({
					role: "assistant",
					text: "",
					thinking: "",
					tools: postBlocks.map((b) => b.tool),
					images: [],
					timestamp,
				});
				continue;
			}
			const message: SessionMessage = {
				role: "assistant",
				text,
				thinking: blockThinking(content),
				tools,
				images: [],
				timestamp: raw.timestamp ?? Date.now(),
				...(text !== sourceText ? { sourceText } : {}),
			};
			if (message.text || message.thinking || message.tools.length > 0) {
				out.push(message);
			}
			continue;
		}
		if (raw.role === "toolResult") {
			const tool = raw.toolCallId ? toolById.get(raw.toolCallId) : undefined;
			if (tool) {
				tool.output = stripAcpReferenceTags(blockText(raw.content));
				tool.isError = raw.isError === true;
				// edit：unified patch 提取进 SessionToolCall.diff（diff 侧栏历史回放数据源；模型不可见）
				if (tool.name === "edit" && !tool.isError) {
					const patch = (raw.details as { patch?: unknown } | undefined)?.patch;
					if (typeof patch === "string" && patch.length > 0) tool.diff = patch;
				}
				// show_image：图片从 details 提取为独立图片消息（紧随其 assistant 消息之后）
				if (tool.name === "show_image" && !tool.isError) {
					const shown = showImageFromDetails(raw.details);
					if (shown) {
						out.push({
							role: "image",
							images: shown.images,
							paths: shown.paths,
							timestamp: raw.timestamp ?? Date.now(),
						});
					}
				}
				// subagent：details 带 results/sessionFile → 独立子代理消息（结构检测，不依赖工具名）
				if (!tool.isError) {
					const runs = extractSubagentRuns(raw.details);
					if (runs) {
						out.push({
							role: "subagent",
							runs,
							timestamp: raw.timestamp ?? Date.now(),
						});
					}
				}
			}
		}
	}
	return out;
}

/**
 * 配对消息与会话树 entry id（assistant 供 fork 定位、user 供撤回定位）：branch 上
 * 同角色消息 entry 按 timestamp 建队列，与上下文消息同序消费；compaction 只截断更早
 * entry，不影响配对。user/assistant 分开建表，避免同 ms 碰撞时串角色。
 * 原地修改 messages 的 entryId 字段。
 */
export function assignEntryIds(messages: SessionMessage[], branch: readonly SessionEntry[]): void {
	const assistantByTimestamp = new Map<number, string[]>();
	const userByTimestamp = new Map<number, string[]>();
	for (const e of branch) {
		if (e.type !== "message") continue;
		const m = e.message as RawMessage;
		if (typeof m.timestamp !== "number") continue;
		const table = m.role === "assistant" ? assistantByTimestamp : m.role === "user" ? userByTimestamp : null;
		if (!table) continue;
		const queue = table.get(m.timestamp);
		if (queue) queue.push(e.id);
		else table.set(m.timestamp, [e.id]);
	}
	for (const message of messages) {
		// 无正文的拆分消息（同 turn 正文后的工具组）不参与配对：无 fork 按钮不消费 entry 队列，
		// 避免挤占后续正文消息的 entryId（同 ms timestamp 碰撞时）
		if (message.role === "assistant") {
			if (!message.text) continue;
			const id = assistantByTimestamp.get(message.timestamp)?.shift();
			if (id) message.entryId = id;
			continue;
		}
		if (message.role === "user") {
			const id = userByTimestamp.get(message.timestamp)?.shift();
			if (id) message.entryId = id;
		}
	}
}
