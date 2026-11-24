import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelService } from "../src/tools/channels/service";
import { ChannelStore } from "../src/tools/channels/store";

let root: string;
let agentDir: string;
let store: ChannelStore;
const alice = { sessionId: "alice" };
const bob = { sessionId: "bob" };
beforeEach(() => {
	mkdirSync(".local/tmp", { recursive: true });
	root = mkdtempSync(join(process.cwd(), ".local/tmp/channels-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir);
	store = new ChannelStore({ projectRoot: root, agentDir });
});
afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

describe("channel store", () => {
	it("opens snapshots without changing files and upgrades to a writer", () => {
		store.manage(alice, { action: "create", topic: "a" });
		store.close();
		const paths = [store.databasePath, store.markerPath];
		const before = paths.map((path) => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }));
		store = new ChannelStore({ projectRoot: root, agentDir });
		expect(store.snapshot("alice")).toHaveLength(1);
		expect(paths.map((path) => ({ content: readFileSync(path), mtime: statSync(path).mtimeMs }))).toEqual(
			before,
		);
		store.manage(bob, { action: "subscribe", topic: "a" });
		expect(store.snapshot("bob")).toHaveLength(1);
	});
	it("rejects incomplete schema without migrating on snapshot", () => {
		store.manage(alice, { action: "create", topic: "a" });
		store.close();
		const db = new DatabaseSync(store.databasePath);
		db.exec("DROP TABLE receipts");
		db.close();
		const before = readFileSync(store.databasePath);
		const mtime = statSync(store.databasePath).mtimeMs;
		store = new ChannelStore({ projectRoot: root, agentDir });
		expect(() => store.snapshot("alice")).toThrow("schema");
		expect(readFileSync(store.databasePath)).toEqual(before);
		expect(statSync(store.databasePath).mtimeMs).toBe(mtime);
		expect(() => store.open(true)).toThrow("schema");
		expect(readFileSync(store.databasePath)).toEqual(before);
		expect(statSync(store.databasePath).mtimeMs).toBe(mtime);
	});
	it("serializes concurrent worker initialization and subscription limits", async () => {
		const first = new ChannelService({ projectRoot: root, agentDir });
		const second = new ChannelService({ projectRoot: root, agentDir });
		try {
			await Promise.all([
				first.manage({ sessionId: "owner1" }, { action: "create", topic: "a" }),
				second.manage({ sessionId: "owner2" }, { action: "create", topic: "b" }),
			]);
			for (let i = 0; i < 4; i++) await first.manage(alice, { action: "create", topic: `x${i}` });
			const results = await Promise.allSettled([
				first.manage(alice, { action: "subscribe", topic: "a" }),
				second.manage(alice, { action: "subscribe", topic: "b" }),
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(await second.snapshot("alice")).toHaveLength(5);
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});
	it("does not write project storage and rejects symlinked agent storage", () => {
		store.manage(alice, { action: "create", topic: "a" });
		store.close();
		store = new ChannelStore({ projectRoot: root, agentDir });
		expect(store.snapshot("alice")).toHaveLength(1);
		expect(existsSync(join(root, ".gitignore"))).toBe(false);
		expect(existsSync(join(root, ".percho"))).toBe(false);
		store.close();
		rmSync(join(agentDir, "channels"), { recursive: true });
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(agentDir, "channels"));
		store = new ChannelStore({ projectRoot: root, agentDir });
		expect(() => store.manage(alice, { action: "create", topic: "b" })).toThrow();
		expect(existsSync(join(outside, "channels.sqlite"))).toBe(false);
	});
	it("preserves existing project ignore files without adding rules", async () => {
		const rootIgnore = join(root, ".gitignore");
		writeFileSync(rootIgnore, "existing-without-newline");
		const dir = join(root, ".percho", "channels");
		mkdirSync(dir, { recursive: true });
		const ignore = join(dir, ".gitignore");
		writeFileSync(ignore, "custom-rule");
		const otherAgent = join(root, "other-agent");
		mkdirSync(otherAgent);
		const first = new ChannelService({ projectRoot: root, agentDir });
		const second = new ChannelService({ projectRoot: root, agentDir: otherAgent });
		try {
			await Promise.all([
				first.manage(alice, { action: "create", topic: "a" }),
				second.manage(bob, { action: "create", topic: "b" }),
			]);
			expect(readFileSync(rootIgnore, "utf8")).toBe("existing-without-newline");
			expect(readFileSync(ignore, "utf8")).toBe("custom-rule");
			expect(existsSync(join(dir, "channels.sqlite"))).toBe(false);
			expect(await first.snapshot("alice")).toEqual([{ topic: "a", unread: 0 }]);
			expect(await second.snapshot("bob")).toEqual([{ topic: "b", unread: 0 }]);
		} finally {
			await Promise.all([first.close(), second.close()]);
		}
	});
	it("requires explicit creation and preserves subscriptions across reopen", () => {
		expect(store.snapshot("alice")).toEqual([]);
		expect(() => store.manage(alice, { action: "subscribe", topic: "missing" })).toThrow();
		store.manage(alice, { action: "create", topic: "  Alpha  " });
		expect(() => store.manage(bob, { action: "create", topic: "Alpha" })).toThrow();
		store.manage(bob, { action: "subscribe", topic: "Alpha" });
		store.manage(bob, { action: "unsubscribe", topic: "Alpha" });
		store.manage(bob, { action: "subscribe", topic: "Alpha" });
		store.close();
		store = new ChannelStore({ projectRoot: root, agentDir });
		expect(store.snapshot("bob")).toEqual([{ topic: "Alpha", unread: 0 }]);
	});
	it("enforces the limit atomically and validates parameters", () => {
		for (let i = 0; i < 5; i++) store.manage(alice, { action: "create", topic: `t${i}` });
		expect(() => store.manage(alice, { action: "create", topic: "overflow" })).toThrow();
		expect(() => store.manage(bob, { action: "subscribe", topic: "overflow" })).toThrow();
		expect(() => store.manage(alice, { action: "create", topic: "bad/name" })).toThrow();
		expect(() => store.manage(alice, { action: "list", scope: "subscribed", limit: 1 })).toThrow();
		expect(() => store.manage(alice, { action: "list", extra: true } as never)).toThrow();
	});
	it("paginates a fixed set and rejects tampered cursors", () => {
		for (const topic of ["a", "c", "e"]) store.manage({ sessionId: topic }, { action: "create", topic });
		const first = store.manage(alice, { action: "list", scope: "all", limit: 1 });
		expect(first.channels.map((c) => c.topic)).toEqual(["a"]);
		store.manage(bob, { action: "create", topic: "b" });
		const second = store.manage(alice, { action: "list", cursor: first.nextCursor, limit: 100 });
		expect(second.channels.map((c) => c.topic)).toEqual(["c", "e"]);
		expect(() => store.manage(alice, { action: "list", cursor: `${first.nextCursor}x` })).toThrow();
	});
	it("keeps empty reads lazy and isolates agent data roots", () => {
		expect(store.manage(alice, { action: "list", scope: "all" }).channels).toEqual([]);
		expect(existsSync(store.databasePath)).toBe(false);
		store.manage(alice, { action: "create", topic: "a" });
		const otherAgent = join(root, "other-agent");
		mkdirSync(otherAgent);
		const other = new ChannelStore({ projectRoot: root, agentDir: otherAgent });
		try {
			expect(other.snapshot("alice")).toEqual([]);
			other.manage(alice, { action: "create", topic: "b" });
			expect(store.snapshot("alice")).toEqual([{ topic: "a", unread: 0 }]);
		} finally {
			other.close();
		}
	});
	it("rejects missing authoritative files and recovers a missing marker only after reopening", () => {
		store.manage(alice, { action: "create", topic: "a" });
		rmSync(store.markerPath);
		expect(() => store.snapshot("alice")).toThrow();
		store.close();
		store = new ChannelStore({ projectRoot: root, agentDir });
		expect(() => store.snapshot("alice")).toThrow();
		expect(existsSync(store.markerPath)).toBe(false);
		store.open(true);
		expect(store.snapshot("alice")).toEqual([{ topic: "a", unread: 0 }]);
		store.close();
		rmSync(store.databasePath);
		store = new ChannelStore({ projectRoot: root, agentDir });
		expect(() => store.snapshot("alice")).toThrow();
	});
	it("does not repair a missing marker when table constraints have been removed", () => {
		store.manage(alice, { action: "create", topic: "a" });
		store.open(true)?.exec("DROP TABLE topics; CREATE TABLE topics (id INTEGER, project TEXT, topic TEXT)");
		store.close();
		rmSync(store.markerPath);
		store = new ChannelStore({ projectRoot: root, agentDir });
		expect(() => store.open(true)).toThrow(/schema/i);
		expect(existsSync(store.markerPath)).toBe(false);
	});
	it("does not overwrite corrupt initialization markers", () => {
		store.manage(alice, { action: "create", topic: "a" });
		writeFileSync(store.markerPath, "broken");
		expect(() => store.snapshot("alice")).toThrow();
	});
});
