import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readSessionHeader } from "../src/session/session-header";

it("accepts a complete header without a newline and bounds reads for oversized headers", async () => {
	const root = resolve(
		import.meta.dirname,
		"../../../.local/tmp/session-archive-catalog/final-identity/header",
	);
	await rm(root, { recursive: true, force: true });
	await mkdir(root, { recursive: true });
	const path = join(root, "session.jsonl");
	try {
		const header = { type: "session", id: "id", cwd: "/project", timestamp: "2024-01-01T00:00:00Z" };
		await writeFile(path, JSON.stringify(header));
		const result = await readSessionHeader(path);
		expect(result.status).toBe("valid");
		if (result.status === "valid") expect(result.meta.messageCount).toBeUndefined();
		await writeFile(path, JSON.stringify({ ...header, padding: "x".repeat(100_000) }));
		let bytes = 0;
		expect(
			(
				await readSessionHeader(path, (n) => {
					bytes += n;
				})
			).status,
		).toBe("ambiguous");
		expect(bytes).toBe(64 * 1024);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
