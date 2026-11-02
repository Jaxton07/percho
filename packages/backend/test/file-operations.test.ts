import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({
	legacy: vi.fn((file: string) => file),
	native: vi.fn((file: string) => file),
}));
vi.mock("node:fs", () => ({ realpathSync: Object.assign(paths.legacy, { native: paths.native }) }));

import { SessionFileOperations } from "../src/session/file-operations";

beforeEach(() => {
	paths.legacy.mockReset().mockImplementation((file) => file);
	paths.native.mockReset().mockImplementation((file) => file);
});

describe("session file identity", () => {
	it("uses the filesystem's native spelling to reuse case aliases and the same operation lease", () => {
		// Model Windows legacy realpath preserving caller spelling. The native Windows
		// integration test also verifies this using actual imported sessions and ACLs.
		const canonical = resolve("fixtures/sessions-subagents/session.jsonl");
		const alias = resolve("fixtures/SESSIONS-SUBAGENTS/session.JSONL");
		paths.native.mockImplementation((file) => (file === alias ? canonical : file));
		const operations = new SessionFileOperations();
		expect(operations.key(alias)).toBe(canonical);
		const lease = operations.acquire([canonical], "preview");
		expect(() => operations.acquire([alias], "open")).toThrow("busy");
		lease.release();
		expect(operations.has(alias)).toBe(false);
	});
	it("does not turn a native permission failure into a different path identity", () => {
		const error = Object.assign(new Error("denied"), { code: "EACCES" });
		paths.native.mockImplementation(() => {
			throw error;
		});
		expect(() => new SessionFileOperations().key("session.jsonl")).toThrow(error);
	});
	it("keeps the reserved absolute identity when a new SDK file does not exist yet", () => {
		paths.native.mockImplementation(() => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		});
		expect(new SessionFileOperations().key("future.jsonl")).toBe(resolve("future.jsonl"));
	});
});
