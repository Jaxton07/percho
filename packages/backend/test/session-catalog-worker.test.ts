import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { SessionCatalog } from "../src/session/catalog";

it("verifies 100 long unindexed sessions without parsing their bodies", async () => {
	const root = resolve(
		import.meta.dirname,
		"../../../.local/tmp/session-archive-catalog/final-identity/worker",
	);
	await rm(root, { recursive: true, force: true });
	const dir = join(root, "sessions", "project");
	await mkdir(dir, { recursive: true });
	const counter = new SharedArrayBuffer(4);
	const worker = new Worker(new URL("../src/session/catalog-worker.ts", import.meta.url), {
		workerData: {
			sessionsDir: join(root, "sessions"),
			indexPath: join(root, "index.db"),
			identityReadCounter: counter,
		},
	});
	let id = 0;
	const rpc = (method: string, params?: unknown): Promise<any> =>
		new Promise((resolve, reject) => {
			const current = ++id;
			const listener = (message: any) => {
				if (message.id !== current) return;
				worker.off("message", listener);
				message.error ? reject(new Error(message.error)) : resolve(message.result);
			};
			worker.on("message", listener);
			worker.postMessage({ id: current, method, params });
		});
	try {
		await rpc("refresh");
		const refs = Array.from({ length: 100 }, (_, n) => ({
			sessionId: `long-${n}`,
			sessionFile: join(dir, `${n}.jsonl`),
		}));
		await Promise.all(
			refs.map((ref) =>
				writeFile(
					ref.sessionFile,
					`${JSON.stringify({ type: "session", id: ref.sessionId, cwd: "/project", timestamp: "2024-01-01T00:00:00Z" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [null] }, padding: "x".repeat(1024 * 1024) })}`,
				),
			),
		);
		const result = await rpc("verify", refs);
		expect(
			result.every((item: any) => item.status === "present" && item.meta?.messageCount === undefined),
		).toBe(true);
		expect(Atomics.load(new Int32Array(counter), 0)).toBe(100 * 4096);
	} finally {
		await rpc("dispose");
		await worker.terminate();
		await rm(root, { recursive: true, force: true });
	}
}, 30000);

it("does not declare a moved archived source missing before reconciliation", async () => {
	const root = resolve(
		import.meta.dirname,
		"../../../.local/tmp/session-archive-catalog/final-identity/move",
	);
	await rm(root, { recursive: true, force: true });
	const dir = join(root, "sessions", "project");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "old.jsonl");
	await writeFile(
		path,
		JSON.stringify({ type: "session", id: "moved", cwd: "/project", timestamp: "2024-01-01T00:00:00Z" }),
	);
	const catalog = new SessionCatalog({
		sessionsDir: join(root, "sessions"),
		indexPath: join(root, "index.db"),
	});
	try {
		await catalog.refresh();
		await catalog.setArchive({ path, archivedAt: 1, archiveRevision: 1 });
		await rename(path, join(dir, "new.jsonl"));
		expect((await catalog.verify([{ sessionId: "moved", sessionFile: path }]))[0].status).toBe("unknown");
		await catalog.refresh();
		expect((await catalog.verify([{ sessionId: "moved" }]))[0].status).toBe("ambiguous");
	} finally {
		await catalog.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("replaces the complete archive projection and clears stale roles after restart", async () => {
	const root = resolve(
		import.meta.dirname,
		"../../../.local/tmp/session-archive-catalog/final-identity/bulk-test",
	);
	await rm(root, { recursive: true, force: true });
	const dir = join(root, "sessions", "project");
	await mkdir(dir, { recursive: true });
	const file = (id: string) => join(dir, `${id}.jsonl`);
	for (const id of ["a", "b"])
		await writeFile(
			file(id),
			JSON.stringify({ type: "session", id, cwd: "/project", timestamp: "2024-01-01T00:00:00Z" }),
		);
	const options = { sessionsDir: join(root, "sessions"), indexPath: join(root, "index.db") };
	const first = new SessionCatalog(options);
	try {
		await first.refresh();
		await first.setArchiveOverlay([{ path: file("a"), archivedAt: 1, archiveRevision: 1 }]);
		await first.setArchiveOverlay([{ path: file("b"), archivedAt: 2, archiveRevision: 1 }]);
		expect((await first.query({ archived: true })).sessions.map((s) => s.sessionId)).toEqual(["b"]);
		await (first as unknown as { worker: Worker }).worker.terminate();
		expect((await first.query({ archived: true })).sessions.map((s) => s.sessionId)).toEqual(["b"]);
		await expect(first.setArchiveOverlay([{ path: "", archiveRevision: 1 }])).rejects.toThrow();
		await expect(first.query({})).rejects.toThrow();
		await first.setArchiveOverlay([{ path: file("a"), archivedAt: 3, archiveRevision: 2 }]);
		await first.setArchive({ path: file("a"), archiveRevision: 3 });
		expect((await first.query({ archived: true })).sessions).toHaveLength(0);
		await first.setArchive({ path: file("b"), archivedAt: 4, archiveRevision: 2 });
	} finally {
		await first.dispose();
	}
	const second = new SessionCatalog(options);
	try {
		await second.setArchiveOverlay([]);
		await second.refresh();
		expect((await second.query({ archived: true })).sessions).toHaveLength(0);
	} finally {
		await second.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("pages with different limits, isolates paths, validates input and preserves uncertain scans", async () => {
	const root = resolve(
		import.meta.dirname,
		"../../../.local/tmp/session-archive-catalog/final-identity/regression",
	);
	await rm(root, { recursive: true, force: true });
	const dir = join(root, "sessions", "subagent-project");
	await mkdir(dir, { recursive: true });
	const file = (n: number) => join(dir, `${String(n).padStart(2, "0")}.jsonl`);
	for (let n = 0; n < 23; n++)
		await writeFile(
			file(n),
			`${JSON.stringify({ type: "session", id: `id${n}`, cwd: "/project", timestamp: "2024-01-01T00:00:00Z" })}\n${JSON.stringify({ type: "session_info", name: n === 1 ? "needle" : "other" })}`,
		);
	const outside = join(root, "private.jsonl");
	await writeFile(
		outside,
		JSON.stringify({ type: "session", id: "secret", cwd: "/secret", timestamp: "2024-01-01T00:00:00Z" }),
	);
	const worker = new Worker(new URL("../src/session/catalog-worker.ts", import.meta.url), {
		workerData: { sessionsDir: join(root, "sessions"), indexPath: join(root, "index.db") },
	});
	let id = 0;
	const rpc = (method: string, params?: unknown): Promise<any> =>
		new Promise((resolve, reject) => {
			const current = ++id;
			const listener = (message: any) => {
				if (message.id !== current) return;
				worker.off("message", listener);
				message.error ? reject(new Error(message.error)) : resolve(message.result);
			};
			worker.on("message", listener);
			worker.postMessage({ id: current, method, params });
		});
	try {
		await rpc("refresh");
		const first = await rpc("query", { limit: 6 });
		await rpc("refresh");
		const second = await rpc("query", { limit: 16, cursor: first.nextCursor });
		expect(second.revision).toBe(first.revision);
		expect(first.total).toBe(23);
		expect(second.sessions).toHaveLength(16);
		expect(new Set([...first.sessions, ...second.sessions].map((s: any) => s.sessionFile)).size).toBe(22);
		await writeFile(file(2), "broken JSON");
		expect((await rpc("query", { search: "needle" })).sessions.map((s: any) => s.sessionId)).toEqual(["id1"]);
		expect((await rpc("verify", [{ sessionFile: outside }]))[0].status).toBe("unknown");
		expect((await rpc("query", {})).complete).toBe(true);
		const missingCwd = join(dir, "missing-cwd.jsonl");
		await writeFile(
			missingCwd,
			JSON.stringify({ type: "session", id: "badcwd", timestamp: "2024-01-01T00:00:00Z" }),
		);
		expect((await rpc("verify", [{ sessionFile: missingCwd }]))[0].status).toBe("ambiguous");
		await expect(rpc("invalidate", { path: missingCwd })).rejects.toThrow();
		expect((await rpc("query", {})).complete).toBe(true);
		await rm(missingCwd);
		await symlink(outside, join(dir, "external.jsonl"));
		expect((await rpc("verify", [{ sessionFile: join(dir, "external.jsonl") }]))[0].status).toBe("unknown");
		await rpc("refresh");
		expect((await rpc("query", {})).sessions).toHaveLength(23);
		expect((await rpc("query", {})).complete).toBe(false);
		await expect(rpc("query", { limit: 1.5 })).rejects.toThrow();
		await expect(rpc("query", { search: 1 })).rejects.toThrow();
		await expect(rpc("query", { bad: true })).rejects.toThrow();
		await expect(rpc("verify", Array(101).fill({ sessionId: "x" }))).rejects.toThrow();
		await rpc("dispose");
	} finally {
		await worker.terminate();
		await rm(root, { recursive: true, force: true });
	}
});

it("indexes, pages, invalidates, archives and verifies in an isolated worker", async () => {
	const root = resolve(
		import.meta.dirname,
		"../../../.local/tmp/session-archive-catalog/final-identity/index-test",
	);
	await rm(root, { recursive: true, force: true });
	await mkdir(join(root, "sessions", "project"), { recursive: true });
	const file = (n: string) => join(root, "sessions", "project", `${n}.jsonl`);
	const save = (n: string, id = n) =>
		writeFile(
			file(n),
			JSON.stringify({ type: "session", id, cwd: "/project", timestamp: "2024-01-01T00:00:00Z" }),
		);
	await save("a");
	await save("b");
	const worker = new Worker(new URL("../src/session/catalog-worker.ts", import.meta.url), {
		workerData: { sessionsDir: join(root, "sessions"), indexPath: join(root, "index.db") },
	});
	let id = 0;
	const rpc = (method: string, params?: unknown): Promise<any> =>
		new Promise((resolve, reject) => {
			const current = ++id;
			const onMessage = (message: any) => {
				if (message.id !== current) return;
				worker.off("message", onMessage);
				message.error ? reject(new Error(message.error)) : resolve(message.result);
			};
			worker.on("message", onMessage);
			worker.postMessage({ id: current, method, params });
		});
	try {
		await rpc("refresh");
		const alias = file("alias");
		await symlink(file("b"), alias);
		const verified = await rpc("verify", [
			{ sessionId: "b", sessionFile: alias },
			{ sessionId: "wrong", sessionFile: file("b") },
		]);
		expect(verified[0].status).toBe("present");
		expect(verified[0].meta.messageCount).toBe(0);
		expect(verified[1].status).toBe("ambiguous");
		await rm(alias);
		const first = await rpc("query", { limit: 1 });
		expect(first.total).toBe(2);
		expect(first.nextCursor).toBeTruthy();
		await rpc("archive", { path: file("a"), archivedAt: 42, archiveRevision: 1 });
		await expect(rpc("query", { limit: 1, cursor: first.nextCursor })).rejects.toThrow(
			"CATALOG_STALE_CURSOR",
		);
		expect((await rpc("query", { archived: true })).sessions[0].sessionId).toBe("a");
		await rpc("refresh");
		expect((await rpc("query", { archived: true })).sessions[0].sessionId).toBe("a");
		await save("a");
		await rpc("invalidate", { path: file("a") });
		expect((await rpc("verify", [{ sessionId: "a", sessionFile: file("a") }]))[0].status).toBe("archived");
		await save("c", "a");
		await rpc("refresh");
		expect((await rpc("verify", [{ sessionId: "a", sessionFile: file("a") }]))[0].status).toBe("ambiguous");
		await writeFile(file("b"), "invalid header");
		await rpc("refresh");
		const incomplete = await rpc("query", {});
		expect(incomplete.complete).toBe(false);
		expect(incomplete.errors).toBe(1);
		expect(incomplete.total).toBeUndefined();
		expect(incomplete.sessions.some((row: any) => row.sessionId === "b")).toBe(true);
		expect(
			(
				await rpc("verify", [{ sessionId: "absent" }, { sessionFile: file("absent") }, { sessionId: "b" }])
			).map((v: any) => v.status),
		).toEqual(["unknown", "unknown", "unknown"]);
		await rm(file("c"));
		await save("b");
		await rm(file("a"));
		await rpc("refresh");
		const missing = (await rpc("verify", [{ sessionId: "a" }, { sessionFile: file("a") }])) as any[];
		expect(missing[0].status).toBe("missing");
		expect(missing[0].meta.archivedAt).toBe(42);
		expect(missing[1].status).toBe("unknown");
		expect((await rpc("query", { archived: true })).sessions[0].sessionId).toBe("a");
		await rpc("remove", { path: file("a") });
		expect((await rpc("query", { archived: true })).sessions).toHaveLength(0);
		await rpc("dispose");
	} finally {
		await worker.terminate();
		await rm(root, { recursive: true, force: true });
	}
});
