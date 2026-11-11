import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { createLargeTextFixture, runLargeText } from "./large-text.mjs";

test("large-turn fixture preserves the original diagnostic session and paragraph", () => {
	const rows = createLargeTextFixture("/isolated/project").trimEnd().split("\n").map(JSON.parse);
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[0], {
		type: "session",
		version: 3,
		id: "switch-diagnostic-large-turn",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/isolated/project",
	});
	assert.equal(rows[1].message.content[0].text, "Synthetic task 0");
	assert.equal(rows[2].parentId, "e0");
	const text = rows[2].message.content[0].text;
	assert.equal(text.length, 4718592);
	assert.equal(Buffer.byteLength(text), 4718592);
	assert.equal(text.split("\n").length, 1);
	assert.equal(text.slice(0, 36), "Synthetic output. Synthetic output. ");
	assert.equal(text.slice(-18), "Synthetic output. ");
	assert.equal(rows[2].message.stopReason, "stop");
	assert.equal(rows[2].message.model, "synthetic");
	// Frozen independently from the first three rows of the original diagnostic fixture.
	assert.equal(
		createHash("sha256").update(createLargeTextFixture("<isolated-project>")).digest("hex"),
		"571f60b7021b4bbfc1f62e49e2735f3a6b37105d681b032b757869d115a8a482",
	);
});

test("suite rejects unknown profiles before touching the host", async () => {
	await assert.rejects(
		runLargeText({ repo: process.cwd(), runDir: "/invalid", profile: "unknown" }),
		/profile/i,
	);
});

test("suite rejects paths outside the isolated performance run", async () => {
	await assert.rejects(
		runLargeText({ repo: process.cwd(), runDir: "/invalid", profile: "quick" }),
		/performance/i,
	);
});

test("fixture content is independent of its project location", () => {
	const messages = (cwd) => createLargeTextFixture(cwd).trimEnd().split("\n").slice(1).map(JSON.parse);
	assert.deepEqual(messages("/one"), messages("/two"));
});

test("suite requires matching isolated run ownership", async () => {
	await assert.rejects(
		runLargeText({
			repo: process.cwd(),
			runDir: join(process.cwd(), ".local/test/performance/example"),
			profile: "quick",
			env: {},
		}),
		/owner|ENOENT|directory mismatch/i,
	);
});
