import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelStore } from "../src/tools/channels/store";

let root: string;
let store: ChannelStore;
const alice = { sessionId: "alice" };
const bob = { sessionId: "bob" };
beforeEach(() => {
	mkdirSync(".local/tmp", { recursive: true });
	root = mkdtempSync(join(process.cwd(), ".local/tmp/channels-message-"));
	mkdirSync(join(root, "agent"));
	store = new ChannelStore({ projectRoot: root, agentDir: join(root, "agent") });
	store.manage(alice, { action: "create", topic: "t" });
	store.manage(bob, { action: "subscribe", topic: "t" });
});
afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

describe("channel messages", () => {
	it("rejects cursors forged using the public database identity", () => {
		for (let i = 0; i < 3; i++) store.post(alice, "t", `${i}`, `p${i}`);
		const page = store.read(bob, { topic: "t", limit: 1 }, "first");
		if (!page.nextCursor) throw new Error("Expected cursor");
		const payload = JSON.parse(Buffer.from(page.nextCursor.split(".")[0], "base64url").toString());
		payload.upper = "999999";
		const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
		const forged = `${encoded}.${createHmac("sha256", payload.id).update(encoded).digest("base64url")}`;
		expect(() => store.read(bob, { topic: "t", cursor: forged }, "forged")).toThrow();
		expect(store.snapshot("bob")[0].unread).toBe(2);
	});
	it("only unlocks archive fences and remembers completed unlocks", () => {
		store.prepareMaintenance("alice", "a", "archive", "source");
		store.completeMaintenance("alice", "a", "active");
		store.completeMaintenance("alice", "a", "active");
		store.prepareMaintenance("alice", "d", "delete", "source");
		expect(() => store.completeMaintenance("alice", "a", "active")).toThrow();
		expect(() => store.completeMaintenance("alice", "d", "active")).toThrow();
		expect(() => store.snapshot("alice")).toThrow();
	});
	it("paginates more than 100 messages backwards and preserves the first subscription baseline", () => {
		for (let i = 0; i < 125; i++) store.post(alice, "t", String(i), `p${i}`);
		const charlie = { sessionId: "charlie" };
		store.manage(charlie, { action: "subscribe", topic: "t" });
		expect(store.snapshot("charlie")[0].unread).toBe(0);
		const pages: string[][] = [];
		let page = store.read(bob, { topic: "t", mode: "recent", limit: 17 }, "recent0");
		pages.push(page.messages.map((m) => m.body));
		while (page.nextCursor) {
			page = store.read(bob, { topic: "t", cursor: page.nextCursor, limit: 17 }, `recent${pages.length}`);
			pages.push(page.messages.map((m) => m.body));
		}
		expect(pages.reverse().flat()).toEqual(Array.from({ length: 125 }, (_, i) => String(i)));
	});
	it("replays posts and unread pages without consuming twice", () => {
		const sent = store.post(alice, "t", " hello ", "p1");
		expect(store.post(alice, "t", " hello ", "p1")).toEqual(sent);
		expect(() => store.post(alice, "t", "other", "p1")).toThrow();
		store.post(alice, "t", "second", "p2");
		const page = store.read(bob, { topic: "t", limit: 1 }, "r1");
		expect(page.messages.map((m) => m.body)).toEqual(["hello"]);
		expect(store.read(bob, { topic: "t", limit: 1 }, "r1")).toEqual(page);
		expect(
			store.read(bob, { topic: "t", cursor: page.nextCursor }, "r2").messages.map((m) => m.body),
		).toEqual(["second"]);
	});
	it("keeps bounded history pages and invalidates stale unread cursors", () => {
		for (let i = 0; i < 15; i++) store.post(alice, "t", `${i}:${"😀".repeat(900)}`, `p${i}`);
		const first = store.read(bob, { topic: "t", mode: "start", limit: 100 }, "h1");
		expect(first.count).toBe(13);
		expect(first.stopReason).toBe("budget");
		store.post(alice, "t", "later", "later");
		const next = store.read(bob, { topic: "t", cursor: first.nextCursor }, "h2");
		expect(next.count).toBe(2);
		const recent = store.read(bob, { topic: "t", mode: "recent", limit: 2 }, "h3");
		expect(recent.messages.map((m) => m.body.slice(0, 3))).toEqual(["14:", "lat"]);
		const older = store.read(bob, { topic: "t", cursor: recent.nextCursor, limit: 2 }, "h4");
		expect(older.messages.map((m) => m.body.slice(0, 3))).toEqual(["12:", "13:"]);
		const unread = store.read(bob, { topic: "t", limit: 1 }, "u1");
		store.read(bob, { topic: "t", limit: 1 }, "u2");
		expect(() => store.read(bob, { topic: "t", cursor: unread.nextCursor }, "u3")).toThrow();
		store.manage(bob, { action: "unsubscribe", topic: "t" });
		store.manage(bob, { action: "subscribe", topic: "t" });
		expect(() => store.read(bob, { topic: "t", limit: 1 }, "u1")).toThrow();
	});
	it("validates unicode and protects cursors across sessions", () => {
		expect(() => store.post(alice, "t", "\ud800", "bad")).toThrow();
		expect(() => store.post(alice, "t", "😀".repeat(1001), "bad")).toThrow();
		store.post(alice, "t", "😀".repeat(1000), "good");
		store.post(alice, "t", "more", "more");
		const page = store.read(bob, { topic: "t", limit: 1 }, "one");
		expect(() => store.read(alice, { topic: "t", cursor: page.nextCursor }, "two")).toThrow();
		expect(() => store.read(bob, { topic: "t", cursor: `${page.nextCursor}x` }, "three")).toThrow();
	});
	it("fences and deletes without erasing sent messages", () => {
		store.post(alice, "t", "hello", "p");
		store.prepareMaintenance("alice", "a", "archive", "source");
		expect(() => store.snapshot("alice")).toThrow();
		store.completeMaintenance("alice", "a", "archived");
		store.prepareMaintenance("alice", "d", "delete", "source");
		expect(() => store.completeMaintenance("alice", "a", "active")).toThrow();
		store.completeMaintenance("alice", "d", "deleted");
		expect(() => store.manage(alice, { action: "subscribe", topic: "t" })).toThrow();
		expect(store.read(bob, { topic: "t" }, "r").messages).toHaveLength(1);
	});
});
