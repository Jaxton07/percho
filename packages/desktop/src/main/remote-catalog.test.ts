import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonStore } from "@percho/backend";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getPath: () => {
			throw new Error("unexpected user data access");
		},
	},
}));

import { RemoteCatalog } from "./remote-catalog";

let dir: string;
let path: string;
beforeEach(async () => {
	await mkdir(".local/tmp", { recursive: true });
	dir = await mkdtemp(join(process.cwd(), ".local/tmp/catalog-"));
	path = join(dir, "connections.json");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const binding = {
	environmentId: "env",
	uid: 1000,
	canonicalAgentDir: "/home/a/.percho",
	node: "/usr/bin/node",
	target: { hostname: "server", user: "alice", port: "22" },
};

it("persists ordered records across restarts", async () => {
	const catalog = new RemoteCatalog("one", path);
	const initial = await catalog.load();
	const first = await catalog.add("dev", initial.revision);
	await catalog.add("prod", first.catalog.revision);
	const restarted = await new RemoteCatalog("two", path).load();
	expect(restarted.epoch).toBe("two");
	expect(restarted.records.map((record) => record.alias)).toEqual(["dev", "prod"]);
	expect(restarted.records[0]?.connectionId).toBe(first.connectionId);
});

it.each([true, false])(
	"migrates legacy identity without inventing a target (target present: %s)",
	async (hasTarget) => {
		const { target, ...withoutTarget } = binding;
		const legacy = { connectionId: "old-id", alias: "dev", ...withoutTarget, ...(hasTarget && { target }) };
		await writeFile(path, JSON.stringify(legacy));
		const first = await new RemoteCatalog("a", path).load();
		expect(first.records).toEqual([
			{ connectionId: "old-id", alias: "dev", revision: 0, binding: hasTarget ? binding : withoutTarget },
		]);
		expect(first.lastSuccessfulConnectionId).toBe("old-id");
		const next = await new RemoteCatalog("b", path).load();
		expect(next.records).toEqual(first.records);
	},
);

it("migrates null and rejects stale additions and duplicate aliases", async () => {
	await writeFile(path, "null");
	const catalog = new RemoteCatalog("a", path);
	const initial = await catalog.load();
	const first = await catalog.add(" dev ", initial.revision);
	await expect(catalog.add("other", initial.revision)).rejects.toThrow();
	await expect(catalog.add("dev", first.catalog.revision)).rejects.toThrow();
	await expect(catalog.add("*", first.catalog.revision)).rejects.toThrow();
	expect(catalog.snapshot().records.map((r) => r.alias)).toEqual(["dev"]);
});

it("binds and removes with record revision and last-successful pointer", async () => {
	const catalog = new RemoteCatalog("a", path);
	const initial = await catalog.load();
	const first = await catalog.add("dev", initial.revision);
	const bound = await catalog.bind(first.connectionId, binding);
	expect(bound.lastSuccessfulConnectionId).toBe(first.connectionId);
	expect(catalog.record(first.connectionId).binding).toEqual(binding);
	expect((await catalog.bind(first.connectionId, binding)).revision).toBe(bound.revision);
	await expect(catalog.remove(first.connectionId, 0)).rejects.toThrow();
	const second = await catalog.add("other", bound.revision);
	const removedOther = await catalog.remove(second.connectionId, 0);
	expect(removedOther.lastSuccessfulConnectionId).toBe(first.connectionId);
	const restarted = new RemoteCatalog("b", path);
	await restarted.load();
	expect(restarted.record(first.connectionId).binding).toEqual(binding);
	const removed = await restarted.remove(first.connectionId, 1);
	expect(removed.lastSuccessfulConnectionId).toBeNull();
	expect(removed.records).toEqual([]);
});

it.each([
	["{broken", "corrupted"],
	[
		JSON.stringify({
			version: 2,
			records: [{ connectionId: "x", alias: "*", revision: 0 }],
			lastSuccessfulConnectionId: null,
		}),
		"invalid",
	],
	[JSON.stringify({ version: 3, records: [] }), "version"],
])("reports bad data without treating it as empty: %s", async (raw, kind) => {
	await writeFile(path, raw);
	const catalog = new RemoteCatalog("a", path);
	const snapshot = await catalog.load();
	expect(snapshot.errorKind).toBe(kind);
	expect(Boolean(snapshot.resetToken)).toBe(kind !== "version");
	await expect(catalog.add("dev", snapshot.revision)).rejects.toThrow();
	expect(() => catalog.record("x")).toThrow();
	await expect(catalog.reset("wrong")).rejects.toThrow();
	expect(await readFile(path, "utf8")).toBe(raw);
});

it("only resets the exact damaged content that was confirmed", async () => {
	await writeFile(path, "{broken");
	const catalog = new RemoteCatalog("a", path);
	const damaged = await catalog.load();
	await writeFile(path, JSON.stringify({ version: 3 }));
	await expect(catalog.reset(damaged.resetToken as string)).rejects.toThrow();
	expect(await readFile(path, "utf8")).toBe('{"version":3}');
	await writeFile(path, "{another");
	const newer = await catalog.load();
	const reset = await catalog.reset(newer.resetToken as string);
	expect(reset.errorKind).toBeUndefined();
	expect(reset.records).toEqual([]);
	expect((await new RemoteCatalog("b", path).load()).records).toEqual([]);
});

it("serializes writers for the same path without losing records", async () => {
	const a = new RemoteCatalog("a", path);
	const b = new RemoteCatalog("a", path);
	await a.load();
	await b.load();
	const first = await a.add("one", 0);
	await expect(b.add("two", 0)).rejects.toThrow();
	await b.load();
	const second = await b.add("two", first.catalog.revision);
	await Promise.all([a.bind(first.connectionId, binding), b.remove(second.connectionId, 0)]);
	const reloaded = await new RemoteCatalog("c", path).load();
	expect(reloaded.records).toHaveLength(1);
	expect(reloaded.records[0]?.binding).toEqual(binding);
});

it("leaves the old identity untouched when migration cannot be saved", async () => {
	const raw = JSON.stringify({ connectionId: "old", alias: "dev", ...binding });
	await writeFile(path, raw);
	const write = vi.spyOn(JsonStore.prototype, "write").mockRejectedValueOnce(new Error("disk full"));
	try {
		const snapshot = await new RemoteCatalog("a", path).load();
		expect(snapshot.errorKind).toBe("io");
		expect(snapshot.resetToken).toBeUndefined();
		expect(await readFile(path, "utf8")).toBe(raw);
	} finally {
		write.mockRestore();
	}
});

it("reports IO errors without offering reset", async () => {
	const catalog = new RemoteCatalog("a", dir);
	const snapshot = await catalog.load();
	expect(snapshot.errorKind).toBe("io");
	expect(snapshot.resetToken).toBeUndefined();
});
