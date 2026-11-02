import {
	buildChatRows,
	deriveTurnChanges,
	deriveTurnTimings,
	emptyTranscript,
	type UIMessage,
} from "@percho/shared";
import { describe, expect, it } from "vitest";

function round(id: string): UIMessage[] {
	return [
		{ kind: "user", id: `user:${id}`, entryId: id, text: "Same question", images: [], timestamp: 1 },
		{
			kind: "assistant",
			id: `assistant:${id}`,
			text: "",
			thinking: "Think",
			timestamp: 2,
			tools: [
				{
					id: "reused-id",
					key: `tool:${id}`,
					name: "write",
					args: JSON.stringify({ path: "same.txt", content: id }),
					output: "Done",
					state: "done",
					endedAt: 3,
				},
			],
		},
	];
}
const rows = (messages: UIMessage[]) =>
	buildChatRows({ ...emptyTranscript(), messages }, "session", 4, {
		turnTimings: deriveTurnTimings(messages),
		turnChanges: deriveTurnChanges(messages),
	});

describe("历史前插的轮次/组/变更身份", () => {
	it("前插不改变已显示轮次、工具组和变更片段的key，turnIndex只更新编号", () => {
		const tail = round("tail"),
			full = [...round("older"), ...tail],
			oldRows = rows(tail),
			fullRows = rows(full);
		for (const row of oldRows)
			expect(fullRows.some((next) => next.key === row.key && next.kind === row.kind)).toBe(true);
		const timing = deriveTurnTimings(full).find((turn) => turn.turnId === "user:tail"),
			changes = deriveTurnChanges(full).find((turn) => turn.turnId === "user:tail");
		expect(timing).toEqual({ turnId: "user:tail", turnIndex: 1, startedAt: 1, endedAt: 3 });
		expect(changes?.files).toEqual(deriveTurnChanges(tail)[0]?.files);
		expect(changes?.files[0]?.sections[0]?.toolCallKey).toBe("tool:tail");
	});
	it("稳定turnId选中进场目标，不因旧页增加轮数而改成另一轮", () => {
		const messages = [...round("older"), ...round("tail")];
		const result = buildChatRows({ ...emptyTranscript(), messages }, "session", 4, {
			turnTimings: deriveTurnTimings(messages),
			enteringTurn: "user:tail",
		});
		expect(result.filter((row) => row.kind === "turnDiff" && row.entering).map((row) => row.key)).toEqual([
			"turn-diff-session-user:tail",
		]);
	});
});
