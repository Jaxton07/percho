import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	messagesToUIMessages,
	previewExcerpt,
	type SessionHistoryWindow,
	type SessionMessage,
	type SessionNavigation,
	type SessionNavigationEntry,
	type UIMessage,
} from "@percho/shared";
import { RUNTIME_MESSAGE_BYTES } from "../runtime/frames";
import { blockImages, blockText, deriveUserMessage } from "./messages";
import type { SourceSnapshot } from "./source-snapshot";

const TARGET_HISTORY_BYTES = 248 * 1024; // 标准样本目标，保留元数据余量；不强拆大单轮。
const MAX_HISTORY_BYTES = RUNTIME_MESSAGE_BYTES - 64 * 1024;
const DEFAULT_TURNS = 4;
type Cursor = {
	v: 2;
	prefixHash: string;
	references: boolean;
	owner: string;
	source: string;
	instance: string;
	generation: string;
	anchor: string;
	branch: string;
	before: string;
	anchorAt: number;
	branchAt: number;
	beforeAt: number;
	turns: number;
};
type Context = { hydrationToken: string; turns?: number; references?: boolean };
type Project = (branch: readonly SessionEntry[], references: boolean) => SessionMessage[];
export interface SelectedHistory {
	messages: SessionMessage[];
	uiMessages: UIMessage[];
	history: SessionHistoryWindow;
}
const user = (entry: SessionEntry | undefined): entry is Extract<SessionEntry, { type: "message" }> =>
	entry?.type === "message" && entry.message.role === "user";
const fail = (message: string): never => {
	throw new Error(`HISTORY_CURSOR_INVALID: ${message}`);
};

/** 原始SDK branch先选完整轮次/依赖，再投影；游标只保存三个由entry身份复核的位置，无额外全树索引。 */
export class SessionHistoryPager {
	// SDK entries are immutable once appended; weak keys release previews with their source.
	private readonly navigationUsers = new WeakMap<
		SessionEntry,
		Omit<SessionNavigationEntry, "entryId" | "ordinal">
	>();
	private readonly navigationReplies = new WeakMap<SessionEntry, string>();
	private counts = {
		indexEntries: 0,
		validatedEntries: 0,
		selectedEntries: 0,
		projectedEntries: 0,
		pages: 0,
	};
	stats() {
		return { ...this.counts };
	}
	private decode(value: string): Cursor {
		if (value.length > 4096) return fail("cursor exceeds its size bound");
		let parsed: Cursor;
		try {
			parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		} catch {
			return fail("malformed cursor");
		}
		if (
			parsed?.v !== 2 ||
			typeof parsed.references !== "boolean" ||
			typeof parsed.prefixHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(parsed.prefixHash) ||
			![
				parsed.owner,
				parsed.source,
				parsed.instance,
				parsed.generation,
				parsed.anchor,
				parsed.branch,
				parsed.before,
			].every((item) => typeof item === "string" && item.length > 0 && item.length <= 512) ||
			![parsed.anchorAt, parsed.branchAt, parsed.beforeAt].every(
				(value) => Number.isSafeInteger(value) && value >= 0,
			) ||
			!Number.isInteger(parsed.turns) ||
			parsed.turns < 1 ||
			parsed.turns > 100
		)
			return fail("invalid cursor fields");
		return parsed;
	}
	/** 只读 user entry 与每轮首段助手正文的轻量导航索引；不投影工具/图片。新鲜度由渲染端 history.generation 驱动重取。 */
	navigation(view: SourceSnapshot, prefix: readonly SessionEntry[]): SessionNavigation {
		if (prefix.length > view.branch.length || prefix.at(-1)?.id !== view.branch[prefix.length - 1]?.id)
			return fail("persistent prefix is not from this source");
		const entries: SessionNavigationEntry[] = [];
		const clip = (text: string) => previewExcerpt(text, 120);
		for (const entry of prefix) {
			if (entry.type !== "message") continue;
			const raw = entry.message as import("./messages").RawMessage;
			if (raw.role === "assistant") {
				const last = entries.at(-1);
				if (last && last.reply === undefined) {
					let reply = this.navigationReplies.get(entry);
					if (reply === undefined) {
						reply = clip(blockText(raw.content));
						this.navigationReplies.set(entry, reply);
					}
					if (reply) last.reply = reply;
				}
				continue;
			}
			if (!user(entry)) continue;
			let preview = this.navigationUsers.get(entry);
			if (!preview) {
				const { text: displayText } = deriveUserMessage(raw);
				const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : Date.parse(entry.timestamp);
				preview = {
					excerpt: clip(displayText),
					timestamp: Number.isFinite(timestamp) ? timestamp : 0,
					images: blockImages(raw.content).length,
				};
				this.navigationUsers.set(entry, preview);
			}
			entries.push({ ...preview, entryId: entry.id, ordinal: entries.length });
		}
		return { entries };
	}
	tail(
		view: SourceSnapshot,
		prefix: readonly SessionEntry[],
		context: Context,
		project: Project,
	): SelectedHistory {
		const turns = context.turns ?? DEFAULT_TURNS;
		if (!Number.isInteger(turns) || turns < 1 || turns > 100)
			throw new Error("History tail must contain between 1 and 100 user rounds");
		return this.select(
			view,
			prefix,
			prefix.length,
			{
				v: 2,
				prefixHash: this.prefixHash(view.branch, view.branch.length),
				references: context.references ?? false,
				owner: view.owner,
				source: view.version,
				instance: context.hydrationToken,
				generation: randomUUID(),
				anchor: prefix.at(-1)?.id ?? "empty",
				branch: view.branch.at(-1)?.id ?? "empty",
				before: "",
				anchorAt: prefix.length - 1,
				branchAt: view.branch.length - 1,
				beforeAt: 0,
				turns,
			},
			project,
		);
	}
	older(
		view: SourceSnapshot,
		prefix: readonly SessionEntry[],
		cursor: string,
		context: Context,
		project: Project,
	): SelectedHistory {
		const parsed = this.validateCursor(view, prefix, cursor, context);
		return this.select(view, prefix, parsed.beforeAt, parsed, project);
	}
	private validateCursor(
		view: SourceSnapshot,
		prefix: readonly SessionEntry[],
		cursor: string,
		context: Context,
	): Cursor {
		const parsed = this.decode(cursor);
		if (
			parsed.owner !== view.owner ||
			parsed.source !== view.version ||
			parsed.instance !== context.hydrationToken
		)
			return fail("source or open instance changed");
		if (
			this.prefixHash(view.branch, parsed.branchAt + 1) !== parsed.prefixHash ||
			parsed.branchAt < parsed.anchorAt ||
			parsed.anchorAt >= prefix.length ||
			parsed.beforeAt > parsed.anchorAt ||
			parsed.beforeAt === 0 ||
			view.branch[parsed.branchAt]?.id !== parsed.branch ||
			prefix[parsed.anchorAt]?.id !== parsed.anchor ||
			prefix[parsed.beforeAt]?.id !== parsed.before ||
			!user(prefix[parsed.beforeAt])
		)
			return fail("branch or page boundary changed");
		return parsed;
	}
	private prefixHash(branch: readonly SessionEntry[], end: number): string {
		this.counts.validatedEntries += Math.min(end, branch.length);
		// Same leaf/anchor IDs do not prove the intervening parent chain is unchanged.
		// Hash only branch identities, not message/image bodies; no additional tree index.
		return createHash("sha256")
			.update(JSON.stringify(branch.slice(0, end).map((entry) => [entry.id, entry.parentId])))
			.digest("hex");
	}
	private select(
		view: SourceSnapshot,
		prefix: readonly SessionEntry[],
		end: number,
		cursor: Cursor,
		project: Project,
	): SelectedHistory {
		if (prefix.length > view.branch.length || prefix.at(-1)?.id !== view.branch[prefix.length - 1]?.id)
			return fail("persistent prefix is not from this source");
		let limit = cursor.turns;
		for (;;) {
			let start = end,
				rounds = 0;
			while (start > 0) {
				start--;
				this.counts.selectedEntries++;
				if (user(prefix[start]) && ++rounds === limit) break;
			}
			// 前导无user段也必须最终可取回。工具结果若跨user边界，向前扩到真实调用所在整轮。
			let scan = start;
			while (scan < end) {
				this.counts.selectedEntries++;
				const entry = prefix[scan++];
				if (entry?.type !== "message" || entry.message.role !== "toolResult" || !entry.message.toolCallId)
					continue;
				const callId = entry.message.toolCallId;
				for (let ancestorAt = scan - 2; ancestorAt >= 0; ancestorAt--) {
					this.counts.selectedEntries++;
					const ancestor = prefix[ancestorAt];
					if (!ancestor) break;
					if (
						ancestor.type === "message" &&
						ancestor.message.role === "assistant" &&
						Array.isArray(ancestor.message.content) &&
						ancestor.message.content.some((block) => block.type === "toolCall" && block.id === callId)
					) {
						let call = ancestorAt;
						if (call < start) {
							while (call > 0 && !user(prefix[call])) {
								this.counts.selectedEntries++;
								call--;
							}
							start = call;
							scan = start;
						}
						break;
					}
				}
			}
			const selected = prefix.slice(start, end);
			this.counts.projectedEntries += selected.length;
			const messages = project(selected, cursor.references),
				uiMessages = messagesToUIMessages(messages);
			const bytes = Buffer.byteLength(JSON.stringify(uiMessages));
			if (bytes > TARGET_HISTORY_BYTES && limit > 1) {
				limit = Math.max(1, Math.floor(Math.min(limit, rounds || 1) / 2));
				continue;
			}
			if (bytes > MAX_HISTORY_BYTES) {
				throw new Error(
					"HISTORY_PAGE_TOO_LARGE: a complete round or dependency group exceeds the logical message budget; nothing was truncated",
				);
			}
			this.counts.pages++;
			const first = selected[0]?.id,
				hasOlder = start > 0;
			let pageTurns = start === 0 && selected.length > 0 && !user(selected[0]) ? 1 : 0;
			for (const entry of selected) if (user(entry)) pageTurns++;
			const history: SessionHistoryWindow = {
				generation: cursor.generation,
				sourceVersion: view.version,
				hydrationToken: cursor.instance,
				hasOlder,
				firstEntryId: first,
				anchorEntryId: cursor.anchor === "empty" ? undefined : cursor.anchor,
				pageEntries: selected.length,
				pageTurns,
			};
			if (hasOlder && first)
				history.cursor = Buffer.from(
					JSON.stringify({ ...cursor, before: first, beforeAt: start }),
					"utf8",
				).toString("base64url");
			return { messages, uiMessages, history };
		}
	}
}
