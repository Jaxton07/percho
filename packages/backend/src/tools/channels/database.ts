import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JsonStore } from "../../json-store";
import type { ChannelFence, DeleteFingerprint } from "./types";

interface Marker {
	version: 1;
	id: string;
}
export type ProjectChannelFence = ChannelFence & { projectRoot: string };

const SCHEMA: Record<string, string> = {
	channel_meta:
		"CREATE TABLE channel_meta (id TEXT NOT NULL, version INTEGER NOT NULL, cursor_secret TEXT NOT NULL)",
	projects: "CREATE TABLE projects (project TEXT PRIMARY KEY)",
	bindings: "CREATE TABLE bindings (session TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT NOT NULL)",
	deletes:
		"CREATE TABLE deletes (project TEXT NOT NULL, op TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(project,op))",
	topics:
		"CREATE TABLE topics (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, topic TEXT NOT NULL COLLATE BINARY, UNIQUE(project,topic))",
	messages:
		"CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, topic TEXT NOT NULL, sender TEXT NOT NULL, name TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL)",
	messages_topic_id: "CREATE INDEX messages_topic_id ON messages(project,topic,id)",
	members:
		"CREATE TABLE members (project TEXT NOT NULL, topic TEXT NOT NULL, session TEXT NOT NULL, active INTEGER NOT NULL, epoch INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(project,topic,session))",
	members_session: "CREATE INDEX members_session ON members(project,session,active)",
	fences:
		"CREATE TABLE fences (project TEXT NOT NULL, session TEXT NOT NULL, state TEXT NOT NULL, op TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(project,session))",
	fences_source: "CREATE INDEX fences_source ON fences(session,source)",
	receipts:
		"CREATE TABLE receipts (project TEXT NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL, call_id TEXT NOT NULL, params TEXT NOT NULL, epoch INTEGER, result TEXT NOT NULL, PRIMARY KEY(project,session,kind,call_id))",
	maintenance_history:
		"CREATE TABLE maintenance_history (project TEXT NOT NULL, session TEXT NOT NULL, op TEXT NOT NULL, PRIMARY KEY(project,session,op))",
};

/** One synchronous connection per worker. Project views share this owner, never its lifetime. */
export class ChannelDatabase {
	readonly databasePath: string;
	readonly markerPath: string;
	readonly marker: JsonStore<Marker | null>;
	private readonly directory: string;
	db: DatabaseSync | null = null;
	databaseId: string | null = null;
	cursorSecret: string | null = null;
	fileIdentity: { dev: number; ino: number } | null = null;
	private readOnly = false;

	constructor(options: { agentDir: string }) {
		this.directory = join(resolve(options.agentDir), "channels");
		this.databasePath = join(this.directory, "channels.sqlite");
		this.markerPath = join(this.directory, "channels.json");
		this.marker = new JsonStore<Marker | null>({
			path: this.markerPath,
			defaultValue: () => null,
			durable: true,
		});
	}

	readMarker(): Marker | null {
		try {
			statSync(this.markerPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		return new JsonStore<Marker>({
			path: this.markerPath,
			defaultValue: () => {
				throw new Error("Missing channel marker");
			},
			parse: (raw) => {
				const value = JSON.parse(raw) as Marker | null;
				if (value?.version !== 1 || typeof value.id !== "string" || !value.id)
					throw new Error("Invalid channel marker");
				return value;
			},
		}).readSync();
	}

	private identity(db: DatabaseSync): { id: string; secret: string } {
		for (const [name, definition] of Object.entries(SCHEMA)) {
			const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name);
			if (row?.sql !== definition)
				throw new Error("Incomplete channel database schema; explicit recovery required");
		}
		const rows = db.prepare("SELECT id, version, cursor_secret FROM channel_meta").all();
		const row = rows[0];
		if (rows.length !== 1 || !row || row.version !== 1 || typeof row.id !== "string" || !row.id)
			throw new Error("Unsupported channel database identity");
		if (typeof row.cursor_secret !== "string" || !/^[0-9a-f]{64}$/.test(row.cursor_secret))
			throw new Error("Invalid channel cursor secret");
		return { id: row.id, secret: row.cursor_secret };
	}

	open(create: true): DatabaseSync;
	open(create?: boolean): DatabaseSync | null;
	open(create = false): DatabaseSync | null {
		let previous: { id: string; dev: number; ino: number } | undefined;
		if (this.db) {
			this.verify();
			if (!create || !this.readOnly) return this.db;
			if (!this.databaseId || !this.fileIdentity) throw new Error("Channel store is closed");
			previous = { id: this.databaseId, ...this.fileIdentity };
			this.close();
		}
		try {
			if (lstatSync(this.directory).isSymbolicLink()) throw new Error("Channel directory is a symbolic link");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const mark = this.readMarker();
		const exists = existsSync(this.databasePath);
		if (!exists && mark) throw new Error("Channel database missing");
		if (!exists && !create) return null;
		if (previous) {
			const stat = statSync(this.databasePath);
			if (mark?.id !== previous.id || stat.dev !== previous.dev || stat.ino !== previous.ino)
				throw new Error("Channel database replaced");
		}
		if (!create && !mark) throw new Error("Channel marker missing; explicit recovery required");
		if (create) mkdirSync(this.directory, { recursive: true });
		if (mark && statSync(this.databasePath).size === 0) throw new Error("Channel database missing or empty");
		const db = new DatabaseSync(this.databasePath, { readOnly: !create });
		try {
			db.exec("PRAGMA busy_timeout=5000");
			if (create) {
				db.exec("BEGIN IMMEDIATE");
				const meta = db
					.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_meta'")
					.get();
				if (!meta) {
					const objects = db
						.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
						.get();
					if (mark || Number(objects?.n) !== 0) throw new Error("Unsupported channel database");
					db.exec(Object.values(SCHEMA).join(";"));
					db.prepare("INSERT INTO channel_meta VALUES (?,1,?)").run(
						randomUUID(),
						randomBytes(32).toString("hex"),
					);
				}
			}
			const identity = this.identity(db);
			if (create && exists && !mark && db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
				throw new Error("Channel database integrity check failed");
			if (mark && mark.id !== identity.id) throw new Error("Channel database identity mismatch");
			if (create) {
				db.exec("COMMIT; BEGIN IMMEDIATE");
				const current = this.readMarker();
				if (current && current.id !== identity.id) throw new Error("Channel marker identity mismatch");
				if (!current) this.marker.writeSync({ version: 1, id: identity.id });
				db.exec("COMMIT");
			}
			this.db = db;
			this.readOnly = !create;
			this.databaseId = identity.id;
			this.cursorSecret = identity.secret;
			const stat = statSync(this.databasePath);
			this.fileIdentity = { dev: stat.dev, ino: stat.ino };
			this.verify();
			return db;
		} catch (error) {
			if (db.isTransaction) db.exec("ROLLBACK");
			db.close();
			this.db = null;
			this.databaseId = null;
			this.cursorSecret = null;
			this.fileIdentity = null;
			throw error;
		}
	}

	verify(): void {
		if (!this.db || !this.fileIdentity || !this.databaseId) throw new Error("Channel store is closed");
		const stat = statSync(this.databasePath);
		if (stat.dev !== this.fileIdentity.dev || stat.ino !== this.fileIdentity.ino)
			throw new Error("Channel database replaced");
		const mark = this.readMarker();
		if (!mark || mark.id !== this.databaseId) throw new Error("Channel marker missing or replaced");
		const row = this.db.prepare("SELECT id,version FROM channel_meta").get();
		if (!row || row.id !== this.databaseId || row.version !== 1)
			throw new Error("Channel database identity changed");
	}

	transaction<T>(fn: (db: DatabaseSync) => T): T {
		const db = this.open(true);
		db.exec("BEGIN IMMEDIATE");
		try {
			this.verify();
			const result = fn(db);
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	private root(root: string): string {
		if (!isAbsolute(root) || root.includes("\0")) throw new Error("Invalid channel project root");
		return resolve(root);
	}
	register(root: string): void {
		const project = this.root(root);
		this.transaction((db) => db.prepare("INSERT OR IGNORE INTO projects VALUES (?)").run(project));
	}
	binding(id: string): { root: string; cwd: string } | undefined {
		const row = this.open(false)?.prepare("SELECT project,cwd FROM bindings WHERE session=?").get(id);
		return row ? { root: String(row.project), cwd: String(row.cwd) } : undefined;
	}
	bind(id: string, root: string, cwd: string): void {
		const project = this.root(root);
		const current = this.root(cwd);
		this.transaction((db) => {
			const existing = db.prepare("SELECT project,cwd FROM bindings WHERE session=?").get(id);
			if (existing && (existing.project !== project || existing.cwd !== current))
				throw new Error("Session binding conflicts with another project");
			db.prepare("INSERT OR IGNORE INTO projects VALUES (?)").run(project);
			db.prepare("INSERT OR IGNORE INTO bindings VALUES (?,?,?)").run(id, project, current);
		});
	}
	deleteFingerprint(root: string, opId: string): DeleteFingerprint | null | undefined {
		const row = this.open(false)
			?.prepare("SELECT fingerprint FROM deletes WHERE project=? AND op=?")
			.get(this.root(root), opId);
		return row ? (JSON.parse(String(row.fingerprint)) as DeleteFingerprint | null) : undefined;
	}
	recordDeleteFingerprint(root: string, opId: string, fingerprint: DeleteFingerprint | null): void {
		this.transaction((db) => {
			if (db.prepare("SELECT 1 FROM deletes WHERE project=? AND op=?").get(this.root(root), opId))
				throw new Error("Delete operation already exists");
			db.prepare("INSERT INTO deletes VALUES (?,?,?)").run(
				this.root(root),
				opId,
				JSON.stringify(fingerprint),
			);
		});
	}
	private fence(row: Record<string, unknown>): ProjectChannelFence {
		return {
			projectRoot: String(row.project),
			sessionId: String(row.session),
			opId: String(row.op),
			source: String(row.source),
			state: row.state as ChannelFence["state"],
			kind: row.state === "archive" || row.state === "archived" ? "archive" : "delete",
		};
	}
	fences(): ProjectChannelFence[] {
		return (
			this.open(false)
				?.prepare("SELECT project,session,op,source,state FROM fences ORDER BY project,session")
				.all() ?? []
		).map((row) => this.fence(row));
	}
	find(sessionId: string, source: string): ProjectChannelFence | undefined {
		const db = this.open(false);
		const rows =
			db
				?.prepare("SELECT project,session,op,source,state FROM fences WHERE session=? AND source=? LIMIT 2")
				.all(sessionId, resolve(source)) ?? [];
		if (rows.length > 1) throw new Error("Ambiguous channel maintenance source");
		if (!rows.length && db?.prepare("SELECT 1 FROM fences WHERE session=? LIMIT 1").get(sessionId))
			throw new Error("Channel maintenance source changed");
		return rows[0] ? this.fence(rows[0]) : undefined;
	}
	close(): void {
		this.db?.close();
		this.db = null;
		this.databaseId = null;
		this.cursorSecret = null;
		this.fileIdentity = null;
		this.readOnly = false;
	}
}
