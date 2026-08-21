import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { formatSkillCommand, parseExpandedSkillInvocation, type SkillInvocation } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { toSessionMessages } from "../src/session/messages";
import type { SessionRegistry } from "../src/session/registry";

const canonicalSkill = (args?: string) =>
	`<skill name="mindmap" location="/tmp/skills/mindmap/SKILL.md">\nReferences are relative to /tmp/skills/mindmap.\n\n# Mind map\n\nBody\n</skill>${args ? `\n\n${args}` : ""}`;

describe("expanded skill invocation parser", () => {
	it("parses the canonical producer format with no args, multiline args, and formats commands", () => {
		const expected: SkillInvocation = {
			name: "mindmap",
			location: "/tmp/skills/mindmap/SKILL.md",
			args: "first\nsecond",
		};
		expect(parseExpandedSkillInvocation(canonicalSkill("  first\nsecond  "))).toEqual(expected);
		expect(parseExpandedSkillInvocation(canonicalSkill())).toEqual({
			name: "mindmap",
			location: "/tmp/skills/mindmap/SKILL.md",
			args: undefined,
		});
		expect(formatSkillCommand(expected)).toBe("/skill:mindmap first\nsecond");
		expect(formatSkillCommand({ name: "mindmap" })).toBe("/skill:mindmap");
	});

	it("rejects non-canonical and partial text, including the SDK helper's wider XML shape", () => {
		for (const text of [
			"ordinary text",
			'<skill name="mindmap" location="/tmp/x">\nbody\n</skill>',
			canonicalSkill().slice(0, -8),
		]) {
			expect(parseExpandedSkillInvocation(text)).toBeNull();
		}
	});
});

describe("skill invocation history projection", () => {
	it("compacts canonical skill user messages while retaining source text for matching", () => {
		const sourceText = canonicalSkill("topic\nwith details");
		const messages = toSessionMessages([
			{ role: "user", content: sourceText, timestamp: 1 },
			{ role: "user", content: "ordinary text", timestamp: 2 },
		]);
		expect(messages[0]).toMatchObject({
			role: "user",
			text: "topic\nwith details",
			skill: { name: "mindmap", args: "topic\nwith details" },
			sourceText,
		});
		expect(messages[1]).toEqual({
			role: "user",
			text: "ordinary text",
			thinking: "",
			tools: [],
			images: [],
			timestamp: 2,
		});
	});

	it("projects a no-argument skill as an empty text bubble", () => {
		expect(toSessionMessages([{ role: "user", content: canonicalSkill(), timestamp: 1 }])[0]).toMatchObject({
			role: "user",
			text: "",
			skill: { name: "mindmap", args: undefined },
			sourceText: canonicalSkill(),
		});
	});
});

describe("PiBackend skill recall", () => {
	it("returns a reusable command while resolving the persisted canonical text", async () => {
		const sourceText = canonicalSkill("layout");
		const sessionManager = SessionManager.inMemory();
		const entryId = sessionManager.appendMessage({
			role: "user",
			content: sourceText,
			timestamp: 1,
		} satisfies Message);
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		registry.add({
			session: {
				sessionId: "s1",
				isStreaming: false,
				isCompacting: false,
				sessionManager,
				agent: { state: {} },
			} as never,
			unsubscribe: () => {},
			cwd: "/tmp",
		});

		await expect(backend.recallMessage("s1", { entryId })).resolves.toEqual({
			text: "/skill:mindmap layout",
			images: [],
		});
	});
});
