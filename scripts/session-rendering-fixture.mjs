/** Synthetic UI events only: no SDK, IO, model or tool execution. Stable across runs. */
export function renderingFixture(tools = 2600) {
	const events = [{ type: "agent_start" }];
	const update = (event) => events.push({ type: "message_update", assistantMessageEvent: event });
	for (let i = 0; i < tools; i++) {
		if (i % 650 === 0) {
			if (i) {
				events.push({ type: "compaction_start", reason: "threshold" });
				events.push({
					type: "compaction_end",
					reason: "threshold",
					result: { summary: "Synthetic summary", tokensBefore: 400000, estimatedTokensAfter: 40000 },
				});
			}
			events.push({
				type: "message_start",
				message: {
					role: "user",
					content: [{ type: "text", text: "Synthetic task" }],
					timestamp: 1700000000000 + i,
				},
			});
		}
		events.push({ type: "turn_start" });
		const name = i < 750 ? "write" : "bash";
		const args =
			name === "write"
				? {
						path: `synthetic/file-${i % 350}.ts`,
						content: Array.from({ length: 30 }, (_, n) => `export const value${n} = ${i};`).join("\n"),
					}
				: { command: `echo synthetic-${i}` };
		const tool = { id: `synthetic-tool-${i}`, name, arguments: args };
		update({ type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", name }] } });
		const raw = JSON.stringify(args),
			chunk = Math.ceil(raw.length / (name === "write" ? 6 : 2));
		for (let n = 0; n < raw.length; n += chunk)
			update({ type: "toolcall_delta", contentIndex: 0, delta: raw.slice(n, n + chunk) });
		update({ type: "toolcall_end", contentIndex: 0, toolCall: tool });
		events.push({ type: "tool_execution_start", toolCallId: tool.id, toolName: name, args });
		events.push({
			type: "tool_execution_update",
			toolCallId: tool.id,
			toolName: name,
			partialResult: "Synthetic output. ".repeat(20),
		});
		events.push({
			type: "tool_execution_end",
			toolCallId: tool.id,
			toolName: name,
			isError: false,
			result: { content: [{ type: "text", text: "Synthetic output" }] },
		});
		events.push({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" } });
		// First group exceeds 500 tools; occasional text creates realistic independent groups.
		if (i >= 500 && i % 100 === 0) {
			events.push({ type: "turn_start" });
			update({ type: "text_delta", contentIndex: 0, delta: "Synthetic progress." });
			events.push({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
		}
	}
	events.push({ type: "compaction_start", reason: "threshold" });
	events.push({
		type: "compaction_end",
		reason: "threshold",
		result: { summary: "Synthetic summary", tokensBefore: 400000, estimatedTokensAfter: 40000 },
	});
	events.push({ type: "agent_end", messages: [] });
	return events;
}

/** Persistent synthetic branch for the real history-open path. Never reads user content. */
export function renderingSession(events, cwd) {
	const timestamp = "2026-01-01T00:00:00.000Z";
	const entries = [{ type: "session", version: 3, id: "rendering-history-synthetic", cwd, timestamp }];
	let parentId = null,
		firstUser,
		tool;
	const append = (value) => {
		const entry = { id: `render-entry-${entries.length}`, parentId, timestamp, ...value };
		entries.push(entry);
		parentId = entry.id;
		return entry.id;
	};
	const assistant = (content, stopReason) =>
		append({
			type: "message",
			message: {
				role: "assistant",
				content,
				stopReason,
				timestamp: 1700000000000 + entries.length,
				api: "openai-completions",
				provider: "synthetic",
				model: "synthetic",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
	for (const event of events) {
		if (event.type === "message_start") {
			firstUser = append({ type: "message", message: event.message });
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
			tool = event.assistantMessageEvent.toolCall;
			assistant([{ type: "toolCall", ...tool }], "toolUse");
		} else if (event.type === "tool_execution_end") {
			append({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: tool.id,
					toolName: tool.name,
					content: [{ type: "text", text: "Synthetic output. ".repeat(20) }],
					isError: false,
					timestamp: 1700000000000 + entries.length,
				},
			});
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			assistant([{ type: "text", text: event.assistantMessageEvent.delta }], "stop");
		} else if (event.type === "compaction_end") {
			append({
				type: "compaction",
				summary: "Synthetic summary",
				firstKeptEntryId: firstUser,
				tokensBefore: 400000,
			});
		}
	}
	return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}
