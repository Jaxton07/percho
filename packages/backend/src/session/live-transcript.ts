import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	emptyTranscript,
	messagesToUIMessages,
	reduceEvent,
	type SessionEvent,
	type SessionTranscriptState,
} from "@percho/shared";
import { toBranchSessionMessages } from "./messages";

/** Only the current turn is retained. Completed history always comes from the authoritative branch. */
export class LiveTranscript {
	sequence = 0;
	private anchor: string | null | undefined;
	private state = emptyTranscript();
	apply(event: SessionEvent, branch: readonly SessionEntry[]): void {
		this.sequence++;
		if (event.type === "turn_start") {
			this.anchor = branch.at(-1)?.id ?? null;
			this.state = { ...this.state, messages: [] };
		}
		this.state = reduceEvent(this.state, event);
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
		runtime: { streaming: boolean; compacting: boolean },
	): SessionTranscriptState {
		const index = this.anchor ? branch.findIndex((entry) => entry.id === this.anchor) : -1;
		if (this.anchor && index < 0) throw new Error("Session branch changed during an active turn");
		const history = this.anchor === undefined ? branch : branch.slice(0, index + 1);
		return {
			...this.state,
			messages: [...messagesToUIMessages(toBranchSessionMessages(history)), ...this.state.messages],
			agentActive: this.state.agentActive || runtime.streaming,
			compacting: runtime.compacting,
		};
	}
}
