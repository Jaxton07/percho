import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { renderingFixture, renderingSession } from "./session-rendering-fixture.mjs";

test("synthetic event stream is deterministic and pairs every execution", () => {
	const events = renderingFixture();
	assert.deepEqual(events, renderingFixture());
	const starts = events.filter((e) => e.type === "tool_execution_start");
	const ends = events.filter((e) => e.type === "tool_execution_end");
	assert.equal(starts.length, 2600);
	assert.deepEqual(
		starts.map((e) => e.toolCallId),
		ends.map((e) => e.toolCallId),
	);
	assert.equal(new Set(starts.map((e) => e.toolCallId)).size, 2600);
	assert.equal(starts.filter((e) => e.toolName === "write").length, 750);
	assert.equal(events.filter((e) => e.type === "compaction_end").length, 4);
	assert.equal(events.at(-1).type, "agent_end");
});

test("persistent branch has complete parents and paired results", () => {
	const entries = renderingSession(renderingFixture(), "/synthetic").trim().split("\n").map(JSON.parse);
	const ids = new Set();
	for (const entry of entries.slice(1)) {
		if (entry.parentId) assert(ids.has(entry.parentId));
		ids.add(entry.id);
	}
	const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
	assert.equal(messages.filter((m) => m.role === "toolResult").length, 2600);
	assert.equal(entries.filter((e) => e.type === "compaction").length, 4);
	assert(
		messages.every(
			(m) =>
				m.role !== "toolResult" ||
				messages.some((a) => a.content?.some((c) => c.type === "toolCall" && c.id === m.toolCallId)),
		),
	);
});

test("all 2600 tools survive the production reducer and frame conflation", async () => {
	const compiled = await build({
		stdin: {
			contents: `export { reduceEvent, emptyTranscript, buildChatRows } from './packages/shared/src/transcript/index.ts'; export { EventConflator } from './packages/desktop/src/renderer/src/stores/event-conflator.ts';`,
			resolveDir: new URL("..", import.meta.url).pathname,
		},
		bundle: true,
		platform: "node",
		format: "cjs",
		write: false,
	});
	const module = { exports: {} };
	new Function("module", "exports", compiled.outputFiles[0].text)(module, module.exports);
	const { reduceEvent, emptyTranscript, buildChatRows, EventConflator } = module.exports;
	const events = renderingFixture();
	const expected = events.reduce(reduceEvent, emptyTranscript());
	let actual = emptyTranscript();
	const conflator = new EventConflator({
		apply: (_id, event) => {
			actual = reduceEvent(actual, event);
		},
		schedule: () => () => {},
	});
	for (const [i, event] of events.entries()) {
		conflator.push("synthetic", structuredClone(event));
		if (i % 17 === 0) conflator.flushNow();
	}
	conflator.dispose();
	const summary = (state) => ({
		active: state.agentActive,
		streaming: state.streaming,
		messages: state.messages.map((m) => ({
			kind: m.kind,
			text: m.text,
			compact: m.compact,
			tools: m.tools?.map((t) => ({
				id: t.id,
				name: t.name,
				args: t.args,
				output: t.output,
				state: t.state,
			})),
		})),
	});
	assert.deepEqual(summary(actual), summary(expected));
	assert.equal(actual.messages.flatMap((m) => m.tools ?? []).length, 2600);
	assert.equal(actual.messages.filter((m) => m.compact?.status === "done").length, 4);
	assert(
		buildChatRows(actual, "synthetic").some(
			(row) => row.kind === "metaGroup" && row.items.reduce((n, item) => n + item.tools.length, 0) >= 500,
		),
	);
});
