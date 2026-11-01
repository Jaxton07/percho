import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type DisplayImage,
	emptyTranscript,
	messagesToUIMessages,
	reduceEvent,
	type SessionEvent,
	type SessionMessage,
	type SessionTranscriptState,
} from "@percho/shared";
import { toBranchSessionMessages } from "./messages";

/** Only the current turn is retained. Completed history always comes from the authoritative branch. */
export class LiveTranscript {
	sequence = 0;
	private anchor: string | null | undefined;
	private userSources = new WeakMap<object, string>();
	private imageSources = new WeakMap<DisplayImage[], object>();
	private state = emptyTranscript();
	apply(
		event: SessionEvent,
		branch: readonly SessionEntry[],
		rawUser?: object,
		rawToolResult?: object,
	): void {
		this.sequence++;
		if (event.type === "turn_start") {
			this.anchor = branch.at(-1)?.id ?? null;
			this.userSources = new WeakMap();
			this.imageSources = new WeakMap();
			this.state = { ...this.state, messages: [] };
		}
		this.state = reduceEvent(this.state, event);
		if (event.type === "message_start" && event.message.role === "user") {
			const user = this.state.messages.findLast((message) => message.kind === "user");
			if (user) this.userSources.set(rawUser ?? event.message, user.id);
		}
		if (event.type === "message_end" && event.message.role === "toolResult") {
			const callId = event.message.toolCallId;
			const group = this.state.streaming?.pendingImages.findLast(
				(images) => images.toolCallId === callId && !this.imageSources.has(images.images),
			);
			if (group) this.imageSources.set(group.images, rawToolResult ?? event.message);
		}
		if (event.type === "turn_end" || event.type === "agent_settled") {
			this.anchor = undefined;
			this.state = { ...this.state, messages: [] };
		}
		// Outside a turn only the running compaction marker is transient; other history is persisted.
		if (this.anchor === undefined)
			this.state = {
				...this.state,
				messages: this.state.messages.filter(
					(message) => message.kind === "system" && message.compact?.status === "running",
				),
			};
	}
	snapshot(
		branch: readonly SessionEntry[],
		runtime: { streaming: boolean; compacting: boolean; ownerSessionId?: string },
		project: (history: readonly SessionEntry[]) => SessionMessage[] = (history) =>
			toBranchSessionMessages(history, runtime.ownerSessionId),
		transient?: (
			sourceId: string,
			kind: "user" | "show",
			images: DisplayImage[],
			details?: object,
		) => DisplayImage[],
	): SessionTranscriptState {
		const index = this.anchor ? branch.findIndex((entry) => entry.id === this.anchor) : -1;
		if (this.anchor && index < 0) throw new Error("Session branch changed during an active turn");
		const history = this.anchor === undefined ? branch : branch.slice(0, index + 1);
		const userEntries = new Map<string, string>();
		for (const entry of branch)
			if (entry.type === "message" && entry.message.role === "user") {
				const row = this.userSources.get(entry.message);
				if (row) userEntries.set(row, entry.id);
			}
		return {
			...this.state,
			messages: [
				...messagesToUIMessages(project(history)),
				...this.state.messages.map((message) =>
					transient && (message.kind === "user" || message.kind === "image")
						? {
								...message,
								...(message.kind === "user" && userEntries.has(message.id)
									? { entryId: userEntries.get(message.id) }
									: {}),
								images: transient(
									message.kind === "image"
										? (message.toolCallId ?? message.entryId ?? message.id)
										: (userEntries.get(message.id) ?? message.entryId ?? message.id),
									message.kind === "user" ? "user" : "show",
									message.images,
									this.imageSources.get(message.images),
								),
							}
						: message,
				),
			],
			streaming:
				this.state.streaming && transient
					? {
							...this.state.streaming,
							pendingImages: this.state.streaming.pendingImages.map((images, index) => ({
								...images,
								images: transient(
									images.toolCallId ?? `pending-${index}`,
									"show",
									images.images,
									this.imageSources.get(images.images),
								),
							})),
						}
					: this.state.streaming,
			agentActive: this.state.agentActive || runtime.streaming,
			compacting: runtime.compacting,
		};
	}
}
