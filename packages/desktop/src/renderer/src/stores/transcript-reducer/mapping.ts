import type { SessionMessage } from "@percho/shared";
import { newSubagentKey, newToolKey } from "./helpers";
import type { UIMessage, UIToolCall } from "./types";

/** 历史消息 → UI 消息（打开历史会话时回放；backend 已按 entryId 配对、正文/工具拆分） */
export function messagesToUIMessages(messages: SessionMessage[]): UIMessage[] {
	const ui: UIMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m) continue;
		const id = `h${i}`;
		if (m.role === "image") {
			ui.push({ kind: "image", id, images: m.images, paths: m.paths, timestamp: m.timestamp });
			continue;
		}
		if (m.role === "subagent") {
			ui.push({
				kind: "subagent",
				id,
				runs: m.runs.map((run) => ({ ...run, key: newSubagentKey() })),
				timestamp: m.timestamp,
			});
			continue;
		}
		if (m.role === "user") {
			if (m.skill || m.text || m.images.length > 0) {
				ui.push({
					kind: "user",
					id,
					text: m.text,
					images: m.images,
					timestamp: m.timestamp,
					entryId: m.entryId,
					skill: m.skill,
					sourceText: m.sourceText,
				});
			}
			continue;
		}
		const tools: UIToolCall[] = m.tools.map((tool) => ({
			key: tool.id || newToolKey(),
			id: tool.id,
			name: tool.name,
			args: tool.args,
			output: tool.output,
			state: tool.isError ? "error" : "done",
		}));
		ui.push({
			kind: "assistant",
			id,
			text: m.text,
			thinking: m.thinking,
			tools,
			timestamp: m.timestamp,
			entryId: m.entryId,
		});
	}
	return ui;
}
