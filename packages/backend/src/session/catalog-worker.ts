// Standalone Node worker: no SDK runtime dependencies.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { SessionCatalogQuery, SessionCatalogReference, SessionMeta } from "@percho/shared";
// Node executes the source worker directly; the workspace compiler does not enable TS extensions.
// @ts-expect-error Node requires the extension for source workers.
import { catalogFingerprint, summarizeCatalogFile } from "./catalog-summary.ts";
// @ts-expect-error Node requires the extension for source workers.
import { readSessionHeader } from "./session-header.ts";

const port = parentPort;
if (!port) throw new Error("Catalog worker requires a parent port");
const {
	sessionsDir,
	indexPath,
	archives = [],
	archiveSnapshotKnown = false,
	identityReadCounter,
} = workerData as {
	sessionsDir: string;
	indexPath: string;
	archives?: Array<Archive & { path: string }>;
	archiveSnapshotKnown?: boolean;
	identityReadCounter?: SharedArrayBuffer;
};
type Archive = { archivedAt?: number; archiveRevision: number; archiveCleanupPending?: boolean };
type Row = {
	path: string;
	id: string;
	cwd: string;
	name: string | null;
	created: number;
	modified: number;
	count: number;
	fingerprint: string;
	readOnly: number;
	archivedAt: number | null;
	archiveRevision: number | null;
	archiveCleanupPending: number | null;
};
const overlay = new Map<string, Archive>();
let hasSnapshot = false;
let db: DatabaseSync;
let complete = false,
	errors = 0,
	disposed = false;
let revision = randomUUID();
let scan: Promise<void> | undefined;
const confirmedMissing = new Set<string>();
let notify: ReturnType<typeof setTimeout> | undefined;
const tick = () => new Promise<void>((done) => setImmediate(done));
function changed() {
	revision = randomUUID();
	if (!notify && !disposed)
		notify = setTimeout(() => {
			notify = undefined;
			if (!disposed) port?.postMessage({ event: "changed", data: { revision, complete } });
		}, 25);
}
function rows(): Row[] {
	return db.prepare("SELECT * FROM sessions").all() as unknown as Row[];
}
function byPath(path: string): Row | undefined {
	return db.prepare("SELECT * FROM sessions WHERE path = ?").get(path) as unknown as Row | undefined;
}
function meta(row: Row): SessionMeta {
	return {
		sessionId: row.id,
		sessionFile: row.path,
		cwd: row.cwd,
		name: row.name ?? undefined,
		active: false,
		messageCount: row.count,
		createdAt: row.created,
		modifiedAt: row.modified,
		readOnly: row.readOnly ? true : undefined,
		archivedAt: row.archivedAt ?? undefined,
		archiveRevision: row.archiveRevision ?? undefined,
		archiveCleanupPending: row.archiveCleanupPending == null ? undefined : !!row.archiveCleanupPending,
	};
}
async function initialize() {
	await mkdir(dirname(indexPath), { recursive: true });
	const open = () => {
		const instance = new DatabaseSync(indexPath);
		try {
			instance.exec(
				"PRAGMA quick_check; CREATE TABLE IF NOT EXISTS sessions (path TEXT PRIMARY KEY, id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT, created REAL NOT NULL, modified REAL NOT NULL, count INTEGER NOT NULL, fingerprint TEXT NOT NULL, readOnly INTEGER NOT NULL, archivedAt REAL, archiveRevision INTEGER, archiveCleanupPending INTEGER); CREATE INDEX IF NOT EXISTS sessions_id ON sessions(id)",
			);
			const check = instance.prepare("PRAGMA quick_check").get() as { quick_check: string };
			if (check.quick_check !== "ok") throw new Error(check.quick_check);
			return instance;
		} catch (error) {
			instance.close();
			throw error;
		}
	};
	try {
		db = open();
	} catch (error) {
		const sqlite = error as { code?: string; errcode?: number; message?: string };
		if (
			sqlite.errcode !== 11 &&
			sqlite.errcode !== 26 &&
			sqlite.code !== "SQLITE_CORRUPT" &&
			sqlite.code !== "SQLITE_NOTADB" &&
			!sqlite.message?.includes("database disk image is malformed")
		)
			throw error;
		await rename(indexPath, `${indexPath}.corrupt-${Date.now()}`);
		db = open();
	}
	db.exec(
		"CREATE INDEX IF NOT EXISTS sessions_project_activity ON sessions(cwd,readOnly,archivedAt,modified DESC,id,path); CREATE INDEX IF NOT EXISTS sessions_project_name ON sessions(cwd,readOnly,name,id,path)",
	);
	if (archiveSnapshotKnown) replaceArchives(archives);
	else {
		const mirror = db.prepare(
			"UPDATE sessions SET archivedAt = ?, archiveRevision = ?, archiveCleanupPending = ? WHERE path = ?",
		);
		for (const { path, ...archive } of archives) {
			overlay.set(path, archive);
			mirror.run(
				archive.archivedAt ?? null,
				archive.archiveRevision,
				archive.archiveCleanupPending == null ? null : Number(archive.archiveCleanupPending),
				path,
			);
		}
	}
}
const belongs = (path: string, root: string) => {
	const p = resolve(path),
		r = resolve(root);
	return p === r || p.startsWith(r + sep);
};
const excluded = (path: string) => belongs(path, `${resolve(sessionsDir)}-subagents`);
async function allowed(path: string) {
	if (excluded(path)) return false;
	try {
		return belongs(await realpath(path), await realpath(sessionsDir));
	} catch {
		// A missing path is only meaningful if its existing parent belongs to the root.
		try {
			return belongs(await realpath(dirname(path)), await realpath(sessionsDir));
		} catch {
			return false;
		}
	}
}
function validString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowedKeys: string[]) {
	if (Object.keys(value).some((key) => !allowedKeys.includes(key)))
		throw new Error("Invalid catalog parameters");
}
async function update(path: string, force = false): Promise<"valid" | "unknown" | "ambiguous"> {
	if (excluded(path)) return "unknown";
	const old = byPath(path);
	if (!force && old) {
		try {
			if (catalogFingerprint(await stat(path)) === old.fingerprint) return "valid";
		} catch {
			/* summarize reports the error */
		}
	}
	const result = await summarizeCatalogFile(path, "");
	if (disposed) return "unknown";
	if (result.status !== "valid") return result.status;
	if (!result.meta.cwd.trim()) return "ambiguous";
	const m = result.meta,
		a =
			overlay.get(path) ??
			(!hasSnapshot && old
				? {
						archivedAt: old.archivedAt ?? undefined,
						archiveRevision: old.archiveRevision ?? undefined,
						archiveCleanupPending:
							old.archiveCleanupPending == null ? undefined : !!old.archiveCleanupPending,
					}
				: undefined);
	db.prepare("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
		path,
		m.sessionId,
		m.cwd,
		m.name ?? null,
		m.createdAt ?? 0,
		m.modifiedAt ?? 0,
		m.messageCount ?? 0,
		result.fingerprint,
		m.readOnly ? 1 : 0,
		a?.archivedAt ?? null,
		a?.archiveRevision ?? null,
		a?.archiveCleanupPending == null ? null : Number(a.archiveCleanupPending),
	);
	changed();
	return "valid";
}
async function reconcile() {
	const previousComplete = complete;
	const previousErrors = errors;
	let scanErrors = 0;
	const found = new Set<string>();
	const existing = new Set(rows().map((row) => row.path));
	let discoveryFailed = false;
	const inspect = async (dir: string, nested: boolean) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			scanErrors++;
			discoveryFailed = true;
			return;
		}
		for (const entry of entries) {
			if (disposed) return;
			const path = join(dir, entry.name);
			if (excluded(path)) continue;
			if (entry.isSymbolicLink()) {
				scanErrors++;
				discoveryFailed = true;
				continue;
			}
			if (entry.isDirectory() && !nested) await inspect(path, true);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.add(path);
		}
	};
	await inspect(sessionsDir, false);
	let n = 0;
	for (const path of found) {
		if (disposed) return;
		if ((await update(path)) !== "valid") scanErrors++;
		if (++n % 4 === 0) await tick();
	}
	if (disposed) return;
	if (!discoveryFailed)
		for (const row of rows())
			if (existing.has(row.path) && belongs(row.path, sessionsDir) && !found.has(row.path)) {
				if (row.archivedAt != null || overlay.get(row.path)?.archivedAt != null) continue;
				db.prepare("DELETE FROM sessions WHERE path = ?").run(row.path);
				changed();
			}
	errors = scanErrors;
	complete = !discoveryFailed && errors === 0;
	confirmedMissing.clear();
	if (complete)
		for (const row of rows())
			if (belongs(row.path, sessionsDir) && !found.has(row.path)) confirmedMissing.add(row.path);
	if (complete !== previousComplete || errors !== previousErrors) changed();
}
function refresh() {
	if (!scan) {
		scan = reconcile().finally(() => {
			scan = undefined;
		});
	}
	return scan;
}
function query(q: SessionCatalogQuery = {}) {
	if (!q || typeof q !== "object" || Array.isArray(q)) throw new Error("Invalid catalog query");
	keys(q as unknown as Record<string, unknown>, ["cwd", "search", "archived", "sort", "limit", "cursor"]);
	if (
		(q.cwd !== undefined && (typeof q.cwd !== "string" || q.cwd.length > 4096)) ||
		(q.search !== undefined && (typeof q.search !== "string" || q.search.length > 4096)) ||
		(q.cursor !== undefined && !validString(q.cursor)) ||
		(q.archived !== undefined && typeof q.archived !== "boolean") ||
		(q.limit !== undefined && typeof q.limit !== "number")
	)
		throw new Error("Invalid catalog query");
	const limit = q.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid catalog limit");
	if (q.sort !== undefined && !["archived", "modified", "created", "name"].includes(q.sort))
		throw new Error("Invalid catalog sort");
	const fingerprint = JSON.stringify([
		q.cwd ?? null,
		q.search ?? "",
		q.archived ?? false,
		q.sort ?? "modified",
	]);
	let offset = 0;
	if (q.cursor) {
		let cursor: { revision: string; fingerprint: string; offset: number };
		try {
			cursor = JSON.parse(Buffer.from(q.cursor, "base64url").toString());
		} catch {
			throw new Error("Invalid catalog cursor");
		}
		if (!cursor || typeof cursor !== "object") throw new Error("Invalid catalog cursor");
		if (cursor.revision !== revision) throw new Error("CATALOG_STALE_CURSOR");
		if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
			throw new Error("Invalid catalog cursor");
		offset = cursor.offset;
	}
	const where = [q.archived ? "archivedAt IS NOT NULL" : "archivedAt IS NULL"];
	const args: string[] = [];
	if (q.cwd) {
		where.push("cwd = ?");
		args.push(q.cwd);
	}
	if (q.search) {
		where.push("(instr(lower(id), lower(?)) > 0 OR instr(lower(coalesce(name, '')), lower(?)) > 0)");
		args.push(q.search, q.search);
	}
	const clause = where.join(" AND ");
	const order =
		q.sort === "name"
			? "coalesce(name, '') ASC"
			: q.sort === "created"
				? "created DESC"
				: q.sort === "archived"
					? "coalesce(archivedAt, 0) DESC"
					: "modified DESC";
	const count = (
		db.prepare(`SELECT count(*) AS count FROM sessions WHERE ${clause}`).get(...args) as { count: number }
	).count;
	const page = db
		.prepare(`SELECT * FROM sessions WHERE ${clause} ORDER BY ${order}, path ASC, id ASC LIMIT ? OFFSET ?`)
		.all(...args, limit, offset) as unknown as Row[];
	const next = offset + limit;
	return {
		sessions: page.map(meta),
		nextCursor:
			next < count
				? Buffer.from(JSON.stringify({ revision, fingerprint, offset: next })).toString("base64url")
				: undefined,
		revision,
		complete,
		errors,
		total: complete && !errors ? count : undefined,
	};
}
function projects() {
	const projects = db
		.prepare(
			"SELECT cwd, SUM(archivedAt IS NULL) AS sessionCount, SUM(archivedAt IS NOT NULL) AS archivedCount, MAX(modified) AS lastActive FROM sessions WHERE readOnly = 0 GROUP BY cwd ORDER BY lastActive DESC,cwd",
		)
		.all();
	return {
		projects,
		revision,
		complete,
		errors,
	};
}
const countIdentityBytes = identityReadCounter
	? (bytes: number) => {
			Atomics.add(new Int32Array(identityReadCounter), 0, bytes);
		}
	: undefined;
let refreshQueued = false;
let refreshAgain = false;
function queueIdentityRefresh() {
	if (disposed) return;
	refreshAgain = true;
	if (refreshQueued) return;
	refreshQueued = true;
	setImmediate(() => {
		void (async () => {
			try {
				do {
					refreshAgain = false;
					await scan;
					if (!disposed) await refresh();
				} while (refreshAgain && !disposed);
			} catch {
				errors++;
				complete = false;
				changed();
			} finally {
				refreshQueued = false;
			}
		})();
	});
}
async function verify(references: unknown) {
	if (!Array.isArray(references) || references.length > 100) throw new Error("Invalid catalog references");
	for (const ref of references) {
		if (!object(ref)) throw new Error("Invalid catalog reference");
		keys(ref, ["sessionId", "sessionFile"]);
		if (
			(ref.sessionId !== undefined && !validString(ref.sessionId)) ||
			(ref.sessionFile !== undefined && !validString(ref.sessionFile))
		)
			throw new Error("Invalid catalog reference");
	}
	return Promise.all(
		(references as SessionCatalogReference[]).map(async (reference) => {
			const { sessionId, sessionFile } = reference;
			const result = (status: string, extra: object = {}) => ({ reference, status, ...extra });
			if (!sessionId && !sessionFile) return result("unknown", { error: "Missing reference" });
			if (sessionFile) {
				if (!(await allowed(sessionFile))) return result("unknown", { error: "Path outside catalog" });
				const summary = await readSessionHeader(sessionFile, countIdentityBytes);
				if (summary.status === "ambiguous") return result("ambiguous", { error: summary.reason });
				if (summary.status === "unknown" && summary.reason !== "ENOENT")
					return result("unknown", { error: summary.reason });
				if (summary.status === "valid") {
					if (!summary.meta.cwd.trim()) return result("ambiguous", { error: "Missing cwd" });
					if (sessionId && summary.meta.sessionId !== sessionId)
						return result("ambiguous", { error: "Session ID mismatch" });
					const matches = db
						.prepare("SELECT * FROM sessions WHERE id = ? LIMIT 2")
						.all(summary.meta.sessionId) as unknown as Row[];
					let canonical: string;
					try {
						canonical = await realpath(sessionFile);
					} catch {
						return result("unknown", { error: "Path changed during verification" });
					}
					for (const match of matches) {
						if (match.path === sessionFile) continue;
						try {
							if ((await realpath(match.path)) === canonical) continue;
						} catch {
							/* missing indexed paths still represent a known identity */
						}
						return result("ambiguous", { error: "Duplicate session ID" });
					}
					const row = byPath(sessionFile) ?? matches[0],
						a = overlay.get(sessionFile) ?? (row && overlay.get(row.path));
					if (row && row.id !== summary.meta.sessionId)
						return result("ambiguous", { error: "Indexed session ID mismatch" });
					const sameIdentity = row?.id === summary.meta.sessionId && row.cwd === summary.meta.cwd;
					if (!sameIdentity || row.fingerprint !== summary.fingerprint) queueIdentityRefresh();
					const value = {
						...(sameIdentity && row.fingerprint === summary.fingerprint
							? { ...meta(row), sessionFile }
							: summary.meta),
						archivedAt: a ? a.archivedAt : (row?.archivedAt ?? undefined),
						archiveRevision: a ? a.archiveRevision : (row?.archiveRevision ?? undefined),
						archiveCleanupPending: a
							? a.archiveCleanupPending
							: row?.archiveCleanupPending == null
								? undefined
								: !!row.archiveCleanupPending,
					};
					return result(value.archivedAt != null ? "archived" : "present", { meta: value });
				}
				if (!sessionId)
					return result("unknown", { error: "Missing path does not establish a missing session identity" });
			}
			if (!sessionId || !complete || errors)
				return result("unknown", { error: "Session identity discovery is incomplete" });
			const matches = db
				.prepare("SELECT * FROM sessions WHERE id = ? LIMIT 2")
				.all(sessionId) as unknown as Row[];
			if (matches.length > 1) return result("ambiguous", { error: "Duplicate session ID" });
			const row = matches[0];
			if (row) {
				if (!(await allowed(row.path))) return result("unknown", { error: "Path outside catalog" });
				const summary = await readSessionHeader(row.path, countIdentityBytes);
				if (summary.status !== "valid") {
					if (summary.status === "unknown" && summary.reason === "ENOENT" && complete && !errors) {
						if (confirmedMissing.has(row.path)) return result("missing", { meta: meta(row) });
						queueIdentityRefresh();
						return result("unknown", { error: "Missing path requires reconciliation" });
					}
					return result(summary.status, { error: summary.reason });
				}
				if (!summary.meta.cwd.trim()) return result("ambiguous", { error: "Missing cwd" });
				if (summary.meta.sessionId !== sessionId)
					return result("ambiguous", { error: "Session ID mismatch" });
				const sameIdentity = row.id === summary.meta.sessionId && row.cwd === summary.meta.cwd;
				if (!sameIdentity || row.fingerprint !== summary.fingerprint) queueIdentityRefresh();
				return result(row.archivedAt != null ? "archived" : "present", {
					meta: {
						...(sameIdentity && row.fingerprint === summary.fingerprint ? meta(row) : summary.meta),
						archivedAt: row.archivedAt ?? undefined,
						archiveRevision: row.archiveRevision ?? undefined,
						archiveCleanupPending:
							row.archiveCleanupPending == null ? undefined : !!row.archiveCleanupPending,
					},
				});
			}
			return result(complete && !errors ? "missing" : "unknown");
		}),
	);
}
function replaceArchives(projections: Array<Archive & { path: string }>) {
	const next = new Map<string, Archive>();
	for (const projection of projections) {
		if (
			!object(projection) ||
			!validString(projection.path) ||
			!Number.isSafeInteger(projection.archiveRevision) ||
			projection.archiveRevision < 0 ||
			(projection.archivedAt !== undefined &&
				(typeof projection.archivedAt !== "number" || !Number.isFinite(projection.archivedAt))) ||
			(projection.archiveCleanupPending !== undefined &&
				typeof projection.archiveCleanupPending !== "boolean")
		)
			throw new Error("Invalid archive");
		keys(projection, ["path", "archivedAt", "archiveRevision", "archiveCleanupPending"]);
		if (next.has(projection.path)) throw new Error("Duplicate archive path");
		const { path, ...state } = projection;
		next.set(path, state);
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(
			"UPDATE sessions SET archivedAt = NULL, archiveRevision = NULL, archiveCleanupPending = NULL WHERE archivedAt IS NOT NULL OR archiveRevision IS NOT NULL OR archiveCleanupPending IS NOT NULL",
		);
		const mirror = db.prepare(
			"UPDATE sessions SET archivedAt = ?, archiveRevision = ?, archiveCleanupPending = ? WHERE path = ?",
		);
		for (const [path, archive] of next)
			mirror.run(
				archive.archivedAt ?? null,
				archive.archiveRevision,
				archive.archiveCleanupPending == null ? null : Number(archive.archiveCleanupPending),
				path,
			);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	hasSnapshot = true;
	overlay.clear();
	for (const [path, archive] of next) overlay.set(path, archive);
	changed();
}
async function run(method: string, params: any) {
	switch (method) {
		case "projects":
			if (params !== undefined && (!object(params) || Object.keys(params).length))
				throw new Error("Invalid catalog parameters");
			return projects();
		case "query":
			return query(params);
		case "verify":
			if (!Array.isArray(params)) {
				if (!object(params)) throw new Error("Invalid catalog references");
				keys(params, ["references"]);
			}
			return verify(Array.isArray(params) ? params : params.references);
		case "refresh":
			if (params !== undefined && (!object(params) || Object.keys(params).length))
				throw new Error("Invalid catalog parameters");
			await refresh();
			return undefined;
		case "invalidate": {
			if (!object(params) || !validString(params.path)) throw new Error("Invalid path");
			keys(params, ["path"]);
			if (!(await allowed(params.path))) throw new Error("Path outside catalog");
			const status = await update(params.path, true);
			if (status !== "valid") throw new Error(`Catalog invalidation failed: ${status}`);
			return undefined;
		}
		case "remove": {
			if (!object(params) || !validString(params.path)) throw new Error("Invalid path");
			keys(params, ["path"]);
			overlay.delete(params.path);
			const result = db.prepare("DELETE FROM sessions WHERE path = ?").run(params.path);
			if (result.changes) changed();
			return undefined;
		}
		case "archiveSnapshot":
			if (!Array.isArray(params)) throw new Error("Invalid archive snapshot");
			replaceArchives(params);
			return undefined;
		case "archive": {
			if (
				!object(params) ||
				!validString(params.path) ||
				typeof params.archiveRevision !== "number" ||
				!Number.isSafeInteger(params.archiveRevision) ||
				params.archiveRevision < 0 ||
				(params.archivedAt !== undefined &&
					(typeof params.archivedAt !== "number" || !Number.isFinite(params.archivedAt))) ||
				(params.archiveCleanupPending !== undefined && typeof params.archiveCleanupPending !== "boolean")
			)
				throw new Error("Invalid archive");
			keys(params, ["path", "archivedAt", "archiveRevision", "archiveCleanupPending"]);
			const a: Archive = {
				archivedAt: params.archivedAt as number | undefined,
				archiveRevision: params.archiveRevision,
				archiveCleanupPending: params.archiveCleanupPending as boolean | undefined,
			};
			const previous = overlay.get(params.path);
			if (
				previous &&
				previous.archivedAt === a.archivedAt &&
				previous.archiveRevision === a.archiveRevision &&
				previous.archiveCleanupPending === a.archiveCleanupPending
			)
				return undefined;
			overlay.set(params.path, a);
			db.prepare(
				"UPDATE sessions SET archivedAt = ?, archiveRevision = ?, archiveCleanupPending = ? WHERE path = ?",
			).run(
				a.archivedAt ?? null,
				a.archiveRevision,
				a.archiveCleanupPending == null ? null : Number(a.archiveCleanupPending),
				params.path,
			);
			changed();
			return undefined;
		}
		case "dispose":
			if (params !== undefined && (!object(params) || Object.keys(params).length))
				throw new Error("Invalid catalog parameters");
			return undefined;
		default:
			throw new Error("Unknown catalog method");
	}
}
let timer: ReturnType<typeof setInterval> | undefined;
const pending = new Set<Promise<void>>();
async function close() {
	if (disposed) return;
	disposed = true;
	if (timer) clearInterval(timer);
	if (notify) clearTimeout(notify);
	await Promise.allSettled([...pending]);
	await ready.catch(() => {});
	await scan?.catch(() => {});
	db?.close();
	port?.close();
}
const ready = initialize();
port.on("message", (message: { id: number; method: string; params?: unknown }) => {
	const task = (async () => {
		try {
			await ready;
			if (disposed) throw new Error("Catalog disposed");
			const result = await run(message.method, message.params);
			port.postMessage({ id: message.id, result });
		} catch (error) {
			port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
		}
	})();
	pending.add(task);
	void task.finally(() => {
		pending.delete(task);
		if (message.method === "dispose") void close();
	});
});
port.on("close", () => {
	void close();
});
void ready
	.then(() => {
		if (disposed) return;
		void refresh().catch(() => {
			errors++;
			complete = false;
			changed();
		});
		timer = setInterval(() => {
			void refresh().catch(() => {
				errors++;
				complete = false;
				changed();
			});
		}, 20_000);
		timer.unref();
	})
	.catch(() => {
		void close();
	});
