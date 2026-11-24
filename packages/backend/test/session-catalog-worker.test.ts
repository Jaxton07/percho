import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { SESSION_CHANNELS } from "@percho/shared";
import { expect, it } from "vitest";
import { SessionCatalog } from "../src/session/catalog";

it("validates refresh as an optional IPC boolean", () => {
	const validate = SESSION_CHANNELS.querySessionCatalog.validate;
	expect(() => validate({ query: {} })).not.toThrow();
	expect(() => validate({ query: { refresh: true } })).not.toThrow();
	expect(() => validate({ query: { refresh: "true" } })).toThrow();
});

it("reports scoped diagnostics and scan lifecycle, and coalesces real retries", async () => {
	const root = resolve(import.meta.dirname, "../../../.local/tmp/sidebar-catalog-status/worker");
	await rm(root, { recursive: true, force: true });
	const dir = join(root, "sessions", "folder");
	await mkdir(dir, { recursive: true });
	const file = (name: string) => join(dir, `${name}.jsonl`);
	const valid = (id: string, cwd: string) =>
		JSON.stringify({ type: "session", id, cwd, timestamp: "2024-01-01T00:00:00Z" });
	await writeFile(file("a"), valid("a", "/a"));
	await writeFile(file("b"), valid("b", "/b"));
	const changes: Array<import("@percho/shared").SessionCatalogChange> = [];
	const catalog = new SessionCatalog({
		sessionsDir: join(root, "sessions"),
		indexPath: join(root, "index.db"),
		onChange: (change) => changes.push(change),
	});
	try {
		await catalog.refresh();
		await writeFile(file("a"), "broken");
		await writeFile(file("unknown"), "broken");
		await writeFile(
			file("header"),
			`${valid("header", "/a")}\n${JSON.stringify({ type: "session_info", name: 42 })}`,
		);
		const page = await catalog.query({ cwd: "/a", refresh: true });
		expect(page.scan).toBeNull();
		expect(page.complete).toBe(false);
		expect(page.diagnostics?.errors).toBe(2);
		expect((await catalog.query({ cwd: "/b" })).diagnostics?.errors).toBe(0);
		expect((await catalog.projects()).diagnostics?.errors).toBe(3);
		expect((await catalog.query({})).diagnostics?.errors).toBe(3);
		await writeFile(file("a"), valid("a", "/a"));
		await rm(file("unknown"));
		await rm(file("header"));
		changes.length = 0;
		const [a, b] = await Promise.all([
			catalog.query({ cwd: "/a", refresh: true }),
			catalog.query({ cwd: "/b", refresh: true }),
		]);
		expect(a.complete && b.complete).toBe(true);
		expect(a.scan).toBeNull();
		expect(a.diagnostics?.errors).toBe(0);
		const starts = changes.filter((change) => change.scan);
		expect(starts).toHaveLength(1);
		expect(starts[0].scan?.id).toBeTruthy();
		expect(starts[0].scan?.startedAt).toBeGreaterThan(0);
		expect(changes.at(-1)?.scan).toBeNull();
		const first = await catalog.query({ limit: 1 });
		const next = await catalog.query({ limit: 1, cursor: first.nextCursor, refresh: true });
		expect(next.sessions).toHaveLength(1);
		await expect(catalog.query({ refresh: "yes" } as never)).rejects.toThrow();
	} finally {
		await catalog.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("keeps cursors across diagnostic-only changes and versions the whole projection", async () => {
	const root = resolve(import.meta.dirname, "../../../.local/tmp/catalog-diagnostics-regression");
	await rm(root, { recursive: true, force: true });
	const dir = join(root, "sessions");
	await mkdir(dir, { recursive: true });
	const valid = (id: string) =>
		JSON.stringify({ type: "session", id, cwd: "/project", timestamp: "2024-01-01T00:00:00Z" });
	await writeFile(join(dir, "a.jsonl"), valid("a"));
	await writeFile(join(dir, "b.jsonl"), valid("b"));
	const changes: Array<import("@percho/shared").SessionCatalogChange> = [];
	const catalog = new SessionCatalog({
		sessionsDir: dir,
		indexPath: join(root, "index.db"),
		onChange: (change) => changes.push(change),
	});
	try {
		await catalog.refresh();
		const first = await catalog.query({ limit: 1 });
		await writeFile(join(dir, "bad.jsonl"), "broken");
		await catalog.refresh();
		const next = await catalog.query({ limit: 1, cursor: first.nextCursor });
		expect(next.sessions).toHaveLength(1);
		expect(next.revision).toBe(first.revision);
		expect(next.complete).toBe(false);
		const diag = next.diagnostics as { revision?: string };
		expect(diag.revision).toBeTruthy();
		expect(diag.revision).not.toBe((first.diagnostics as { revision?: string }).revision);
		expect((await catalog.projects()).diagnostics).toEqual(next.diagnostics);
		expect(changes.at(-1)?.diagnostics).toEqual(next.diagnostics);
		await catalog.refresh();
		expect((await catalog.query({})).diagnostics).toEqual(next.diagnostics);
		await writeFile(
			join(dir, "bad.jsonl"),
			`${valid("bad")}\n${JSON.stringify({ type: "session_info", name: 42 })}`,
		);
		await catalog.refresh();
		const scoped = await catalog.query({ cwd: "/project" });
		expect(scoped.diagnostics?.errors).toBe(1);
		expect(scoped.diagnostics?.revision).not.toBe(diag.revision);
		await rm(join(dir, "bad.jsonl"));
		const restored = await catalog.query({ limit: 1, cursor: first.nextCursor, refresh: true });
		expect(restored.complete).toBe(true);
		expect((restored.diagnostics as { revision?: string }).revision).not.toBe(diag.revision);
	} finally {
		await catalog.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("queues concurrent explicit retries behind a running ordinary scan", async () => {
	const root = resolve(import.meta.dirname, "../../../.local/tmp/catalog-retry-regression");
	await rm(root, { recursive: true, force: true });
	const dir = join(root, "sessions");
	await mkdir(dir, { recursive: true });
	for (let i = 0; i < 150; i++)
		await writeFile(
			join(dir, `${i}.jsonl`),
			JSON.stringify({ type: "session", id: `${i}`, cwd: "/project", timestamp: "2024-01-01T00:00:00Z" }),
		);
	const changes: Array<import("@percho/shared").SessionCatalogChange> = [];
	let onStart: (() => void) | undefined;
	const catalog = new SessionCatalog({
		sessionsDir: dir,
		indexPath: join(root, "index.db"),
		onChange: (change) => {
			changes.push(change);
			if (change.scan) onStart?.();
		},
	});
	try {
		await catalog.refresh();
		changes.length = 0;
		let retries!: Promise<
			[import("@percho/shared").SessionCatalogPage, import("@percho/shared").SessionCatalogPage]
		>;
		let active!: Promise<import("@percho/shared").SessionCatalogPage>;
		onStart = () => {
			onStart = undefined;
			active = catalog.query({});
			retries = Promise.all([catalog.query({ refresh: true }), catalog.query({ refresh: true })]);
		};
		const ordinary = catalog.refresh();
		await ordinary;
		const [a, b] = await retries;
		await ordinary;
		const starts = changes.filter((change) => change.scan);
		const ids = [...new Set(starts.map((change) => change.scan?.id))];
		expect(ids).toHaveLength(2);
		const snapshot = (await active).scan;
		expect(snapshot?.id).toBe(ids[0]);
		expect(snapshot?.elapsedMs).toBeGreaterThanOrEqual(0);
		for (const change of starts)
			expect((change.scan as { elapsedMs?: number }).elapsedMs).toBeGreaterThanOrEqual(0);
		expect(a.scan).toBeNull();
		expect(b.scan).toBeNull();
	} finally {
		await catalog.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

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
