import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ChannelDatabase } from "../src/tools/channels/database";
import { ChannelStore } from "../src/tools/channels/store";

let fixture: string;
beforeEach(() => {
	mkdirSync(".local/tmp", { recursive: true });
	fixture = mkdtempSync(join(process.cwd(), ".local/tmp/channel-single-"));
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

it("rejects cross-project cursors and confines maintenance to its own project", () => {
	const agentDir = join(fixture, "agent");
	const database = new ChannelDatabase({ agentDir });
	const first = new ChannelStore({ projectRoot: join(fixture, "a"), agentDir, database });
	const second = new ChannelStore({ projectRoot: join(fixture, "b"), agentDir, database });
	const actor = { sessionId: "same" };
	const reader = { sessionId: "reader" };
	try {
		for (const store of [first, second]) {
			store.manage(actor, { action: "create", topic: "one" });
			store.manage(actor, { action: "create", topic: "two" });
			store.manage(reader, { action: "subscribe", topic: "one" });
			store.post(actor, "one", "first", "post1");
			store.post(actor, "one", "second", "post2");
		}
		const list = first.manage(actor, { action: "list", scope: "all", limit: 1 });
		expect(list.nextCursor).toBeDefined();
		expect(() => second.manage(actor, { action: "list", cursor: list.nextCursor })).toThrow(/cursor/i);
		const page = first.read(reader, { topic: "one", mode: "unread", limit: 1 }, "page");
		expect(page.nextCursor).toBeDefined();
		expect(() => second.read(reader, { topic: "one", cursor: page.nextCursor }, "cross")).toThrow(/cursor/i);
		expect(second.snapshot("reader")).toEqual([{ topic: "one", unread: 2 }]);
		first.prepareMaintenance("same", "archive", "archive", join(fixture, "a.jsonl"));
		first.completeMaintenance("same", "archive", "archived");
		expect(() => first.post(actor, "one", "blocked", "post3")).toThrow(/fenced/i);
		expect(second.post(actor, "one", "still active", "post3").body).toBe("still active");
		first.completeMaintenance("same", "archive", "active");
		first.prepareMaintenance("same", "delete", "delete", join(fixture, "a.jsonl"));
		first.completeMaintenance("same", "delete", "deleted");
		expect(() => first.snapshot("same")).toThrow(/fenced/i);
		expect(second.snapshot("same")).toHaveLength(2);
		expect(database.find("same", join(fixture, "a.jsonl"))).toMatchObject({
			projectRoot: first.projectRoot,
			state: "deleted",
		});
		expect(
			second.read(reader, { topic: "one", mode: "start" }, "history").messages.map((message) => message.body),
		).toEqual(["first", "second", "still active"]);
	} finally {
		database.close();
	}
});

it("uses one agent database while isolating projects and leaving their files unchanged", () => {
	const agentDir = join(fixture, "agent");
	const a = join(fixture, "a");
	const b = join(fixture, "b");
	for (const path of [agentDir, a, b]) mkdirSync(path);
	writeFileSync(join(a, ".gitignore"), "keep\n");
	const first = new ChannelStore({ projectRoot: a, agentDir });
	const second = new ChannelStore({ projectRoot: b, agentDir });
	try {
		const actor = { sessionId: "same" };
		first.manage(actor, { action: "create", topic: "same" });
		second.manage(actor, { action: "create", topic: "same" });
		first.post(actor, "same", "one", "call");
		second.post(actor, "same", "two", "call");
		expect(first.databasePath).toBe(second.databasePath);
		expect(first.read(actor, { topic: "same", mode: "start" }, "read").messages[0].body).toBe("one");
		expect(second.read(actor, { topic: "same", mode: "start" }, "read").messages[0].body).toBe("two");
		expect(readFileSync(join(a, ".gitignore"), "utf8")).toBe("keep\n");
		expect(existsSync(join(a, ".percho"))).toBe(false);
		expect(existsSync(join(b, ".percho"))).toBe(false);
	} finally {
		first.close();
		second.close();
	}
});

it("retains data after copying the agent directory and removing the project", () => {
	const agentDir = join(fixture, "agent");
	const copied = join(fixture, "copied");
	const projectRoot = join(fixture, "project");
	mkdirSync(agentDir);
	mkdirSync(projectRoot);
	const first = new ChannelStore({ projectRoot, agentDir });
	first.manage({ sessionId: "a" }, { action: "create", topic: "topic" });
	first.post({ sessionId: "a" }, "topic", "message", "call");
	first.close();
	cpSync(agentDir, copied, { recursive: true });
	rmSync(projectRoot, { recursive: true });
	const restored = new ChannelStore({ projectRoot, agentDir: copied });
	try {
		expect(
			restored.read({ sessionId: "a" }, { topic: "topic", mode: "start" }, "read").messages[0].body,
		).toBe("message");
		expect(existsSync(projectRoot)).toBe(false);
	} finally {
		restored.close();
	}
});
