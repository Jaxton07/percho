import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Deterministic SDK session JSONL; cwd must be an isolated, extension-free project. */
export function sessionJsonl(turns, cwd) {
	if (!Number.isSafeInteger(turns) || turns < 1 || turns > 10000 || !cwd)
		throw new Error("Invalid fixture parameters");
	const stamp = "2026-01-01T00:00:00.000Z";
	const entries = [{ type: "session", version: 3, id: `review-${turns}`, timestamp: stamp, cwd }];
	let parentId = null;
	const add = (message) => {
		const id = `t${turns}-e${entries.length}`;
		entries.push({ type: "message", id, parentId, timestamp: stamp, message });
		parentId = id;
	};
	for (let i = 0; i < turns; i++) {
		add({
			role: "user",
			content: [
				{
					type: "text",
					text:
						`REVIEW_TURN_${i} Please inspect the implementation of task ${i}. Explain the tradeoffs and retain existing interactions. ` +
						"Deterministic synthetic prompt. ".repeat((i % 4) + 1),
				},
			],
			timestamp: 1700000000000 + i * 1000,
		});
		let text =
			`## Result ${i}\n\n` +
			Array.from(
				{ length: 3 + (i % 5) },
				(_, j) =>
					`Paragraph ${j}: ` +
					"This is a deterministic synthetic response for testing scrolling, switching sessions, and rendering Markdown without calling a model. ".repeat(
						3,
					),
			).join("\n\n");
		if (i % 10 === 0)
			text += `\n\n\`\`\`typescript\n${Array.from({ length: 18 }, (_, j) => `export const value${j} = ${i + j};`).join("\n")}\n\`\`\`\n`;
		add({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "synthetic",
			model: "synthetic",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1700000000500 + i * 1000,
		});
	}
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export async function writeFixtures(directory, cwd, turns) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const n of turns)
		await writeFile(join(directory, `${n}.jsonl`), sessionJsonl(n, cwd), { mode: 0o600 });
}
