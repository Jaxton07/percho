import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeCatalogFile } from "../src/session/catalog-summary";

const root = resolve(
	import.meta.dirname,
	"../../../.local/tmp/session-archive-catalog/ticket02/summary-test",
);
const previousEnv = {
	HOME: process.env.HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
const header = {
	type: "session",
	version: 3,
	id: "example",
	cwd: "/project",
	timestamp: "2024-01-01T00:00:00.000Z",
};
const encode = (rows: unknown[]) =>
	rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n");

beforeAll(async () => {
	await mkdir(root, { recursive: true });
});
afterAll(async () => {
	for (const [key, value] of Object.entries(previousEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});

describe("catalog file summaries", () => {
	it("agrees with the SDK on representative historical metadata", async () => {
		const directory = join(root, "sdk-diff");
		await mkdir(directory, { recursive: true });
		process.env.HOME = join(root, "home");
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		process.env.XDG_CONFIG_HOME = join(root, "config");
		process.env.XDG_CACHE_HOME = join(root, "cache");
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		for (let i = 0; i < 60; i++) {
			const rows: unknown[] = [{ ...header, id: `id-${i}` }];
			switch (i % 6) {
				case 0:
					rows.push({ type: "session_info", name: " one " }, { type: "session_info", name: " two " });
					break;
				case 1:
					rows.push({ type: "session_info", name: "one" }, { type: "session_info", name: null });
					break;
				case 2:
					rows.push({
						type: "message",
						timestamp: "2024-02-01T00:00:00.000Z",
						message: { role: "user", content: "private" },
					});
					break;
				case 3:
					rows.push({ type: "message", message: { role: "toolResult", content: "private" } });
					break;
				case 4:
					rows.push("{bad", { type: "custom", data: "private" });
					break;
			}
			await writeFile(join(directory, `${i}.jsonl`), encode(rows));
		}
		const sdk = await SessionManager.listAll(directory);
		expect(sdk).toHaveLength(60);
		for (const info of sdk) {
			const result = await summarizeCatalogFile(info.path, "/fallback");
			expect(result.status).toBe("valid");
			if (result.status !== "valid") throw new Error(result.reason);
			expect(result.meta).toEqual({
				sessionId: info.id,
				sessionFile: info.path,
				cwd: info.cwd || "/fallback",
				name: info.name,
				active: false,
				messageCount: info.messageCount,
				createdAt: info.created.getTime(),
				modifiedAt: info.modified.getTime(),
			});
		}
	});
	it("matches SDK metadata without retaining messages and honors cleared names", async () => {
		const path = join(root, "valid.jsonl");
		await writeFile(
			path,
			encode([
				header,
				{ type: "session_info", name: " old " },
				{ type: "session_info", name: "  " },
				{ type: "message", message: { role: "user", timestamp: 1705000000000, content: "secret body" } },
				{ type: "message", message: { role: "toolResult", content: "private" } },
				"{bad",
			]),
		);
		const result = await summarizeCatalogFile(path, "/fallback");
		expect(result.status).toBe("valid");
		if (result.status !== "valid") throw new Error(result.reason);
		expect(result.meta).toEqual({
			sessionId: "example",
			sessionFile: path,
			cwd: "/project",
			name: undefined,
			active: false,
			messageCount: 2,
			createdAt: 1704067200000,
			modifiedAt: 1705000000000,
		});
		expect(JSON.stringify(result)).not.toContain("secret body");
	});
	it("does not treat missing or damaged identity as a valid summary", async () => {
		expect((await summarizeCatalogFile(join(root, "missing.jsonl"), "/fallback")).status).toBe("unknown");
		const path = join(root, "damaged.jsonl");
		await writeFile(path, `{bad\n${JSON.stringify(header)}`);
		expect((await summarizeCatalogFile(path, "/fallback")).status).toBe("ambiguous");
	});
	it("rejects a file changed while being read", async () => {
		const path = join(root, "changing.jsonl");
		await writeFile(path, encode([header, { type: "custom", data: "x" }]));
		const result = await summarizeCatalogFile(path, "/fallback", async (line) => {
			if (line === 1) await appendFile(path, "\n{}");
		});
		expect(result.status).toBe("unknown");
	});
});
