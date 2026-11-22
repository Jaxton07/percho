import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JsonStore } from "../../json-store";
import type {
	ChannelActor,
	ChannelEntry,
	ChannelFence,
	ChannelManageParams,
	ChannelManageResult,
	ChannelMessage,
	ChannelReadParams,
	ChannelReadResult,
	ChannelSnapshotEntry,
} from "./types";

interface Marker {
	version: 1;
	id: string;
}
interface Cursor {
	version: 1;
	type: "channel-list";
	id: string;
	project: string;
	upper: string;
	after: string;
}
interface MessageCursor {
	version: 1;
	type: "channel-message";
	id: string;
	project: string;
	topic: string;
	mode: "unread" | "recent" | "start";
	upper: string;
	after: string;
	session?: string;
	epoch?: number;
}

/** Synchronous authority: call only on a worker thread or in tests. */
export class ChannelStore {
	readonly projectRoot: string;
	readonly namespace: string;
	readonly databasePath: string;
	readonly markerPath: string;
	readonly marker: JsonStore<Marker | null>;
	db: DatabaseSync | null = null;
	databaseId: string | null = null;
	private cursorSecret: string | null = null;
	fileIdentity: { dev: number; ino: number } | null = null;

	constructor(options: { projectRoot: string; agentDir: string }) {
		this.projectRoot = realpathSync(options.projectRoot);
		this.namespace = createHash("sha256").update(realpathSync(options.agentDir)).digest("hex");
		const dir = join(this.projectRoot, ".percho", "channels");
		this.databasePath = join(dir, `${this.namespace}.sqlite`);
		this.markerPath = join(dir, `${this.namespace}.json`);
		this.marker = new JsonStore<Marker | null>({
			path: this.markerPath,
			defaultValue: () => null,
			durable: true,
		});
	}

	readMarker(): Marker | null {
		// Distinguish a missing marker from access errors; never replace a corrupted marker.
		try {
			statSync(this.markerPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		const checked = new JsonStore<Marker>({
			path: this.markerPath,
			defaultValue: () => {
				throw new Error("Missing channel marker");
			},
			parse: (raw) => {
				const value: unknown = JSON.parse(raw);
				if (
					!value ||
					typeof value !== "object" ||
					(value as Marker).version !== 1 ||
					typeof (value as Marker).id !== "string" ||
					!(value as Marker).id
				)
					throw new Error("Invalid channel marker");
				return value as Marker;
			},
		});
		// A throwing fallback makes JsonStore's synchronous read strict on corruption and IO errors.
		return checked.readSync();
	}

	open(create = false): DatabaseSync | null {
		if (this.db) {
			this.verify();
			return this.db;
		}
		for (const path of [join(this.projectRoot, ".percho"), join(this.projectRoot, ".percho", "channels")]) {
			try {
				if (lstatSync(path).isSymbolicLink()) throw new Error("Channel directory is a symbolic link");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const mark = this.readMarker();
		const exists = existsSync(this.databasePath);
		if (!exists && mark) throw new Error("Channel database missing");
		if (!exists && !create) return null;
		if (!exists && create) {
			const ignorePath = join(this.projectRoot, ".gitignore");
			const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
			if (!ignore.split(/\r?\n/).includes("/.percho/channels/"))
				appendFileSync(ignorePath, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}/.percho/channels/\n`);
		}
		mkdirSync(join(this.projectRoot, ".percho", "channels"), { recursive: true });
		const empty = !exists || statSync(this.databasePath).size === 0;
		if (empty && mark) throw new Error("Channel database missing or empty");
		const db = new DatabaseSync(this.databasePath);
		try {
			db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
			const meta = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channel_meta'")
				.get();
			if (!meta) {
				const objects = db
					.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
					.get();
				if (mark || Number(objects?.n) !== 0) throw new Error("Unsupported channel database");
				db.exec(`CREATE TABLE channel_meta (id TEXT NOT NULL, version INTEGER NOT NULL);
					CREATE TABLE topics (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL UNIQUE COLLATE BINARY);
					CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, sender TEXT NOT NULL, name TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
					CREATE INDEX messages_topic_id ON messages(topic,id);
					CREATE TABLE members (topic TEXT NOT NULL, session TEXT NOT NULL, active INTEGER NOT NULL, epoch INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(topic,session));
					CREATE INDEX members_session ON members(session,active);
					CREATE TABLE fences (session TEXT PRIMARY KEY, state TEXT NOT NULL, op TEXT, source TEXT);`);
				db.prepare("INSERT INTO channel_meta VALUES (?, 1)").run(randomUUID());
			}
			db.exec(
				`CREATE TABLE IF NOT EXISTS receipts (session TEXT NOT NULL, kind TEXT NOT NULL, call_id TEXT NOT NULL, params TEXT NOT NULL, epoch INTEGER, result TEXT NOT NULL, PRIMARY KEY(session,kind,call_id));`,
			);
			const columns = db.prepare("PRAGMA table_info(channel_meta)").all();
			if (!columns.some((column) => column.name === "cursor_secret"))
				db.exec("ALTER TABLE channel_meta ADD COLUMN cursor_secret TEXT");
			db.prepare("UPDATE channel_meta SET cursor_secret=? WHERE cursor_secret IS NULL").run(
				randomBytes(32).toString("hex"),
			);
			db.exec(
				"CREATE TABLE IF NOT EXISTS maintenance_history (session TEXT NOT NULL, op TEXT NOT NULL, PRIMARY KEY(session,op))",
			);
			const row = db.prepare("SELECT id, version, cursor_secret FROM channel_meta").all();
			const first = row[0];
			if (row.length !== 1 || !first || first.version !== 1 || typeof first.id !== "string")
				throw new Error("Unsupported channel database identity");
			const id = first.id;
			if (typeof first.cursor_secret !== "string" || !/^[0-9a-f]{64}$/.test(first.cursor_secret))
				throw new Error("Invalid channel cursor secret");
			const secret = first.cursor_secret;
			if (mark && mark.id !== id) throw new Error("Channel database identity mismatch");
			db.exec("COMMIT");
			// Serialize recovery and marker publication across processes using the database lock.
			db.exec("BEGIN IMMEDIATE");
			const current = this.readMarker();
			if (current && current.id !== id) throw new Error("Channel marker identity mismatch");
			if (!current) this.marker.writeSync({ version: 1, id });
			db.exec("COMMIT");
			this.db = db;
			this.databaseId = id;
			this.cursorSecret = secret;
			const stat = statSync(this.databasePath);
			this.fileIdentity = { dev: stat.dev, ino: stat.ino };
			this.verify();
			return db;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* no transaction */
			}
			db.close();
			this.db = null;
			this.databaseId = null;
			this.cursorSecret = null;
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
		const row = this.db.prepare("SELECT id, version FROM channel_meta").get();
		if (!row || row.id !== this.databaseId || row.version !== 1)
			throw new Error("Channel database identity changed");
	}

	transaction<T>(fn: (db: DatabaseSync) => T): T {
		const db = this.open(true);
		if (!db) throw new Error("Channel database unavailable");
		db.exec("BEGIN IMMEDIATE");
		try {
			this.verify();
			const value = fn(db);
			db.exec("COMMIT");
			return value;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	assertActive(sessionId: string, currentDb?: DatabaseSync): void {
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid session identity");
		const db = currentDb ?? this.open(false);
		if (db?.prepare("SELECT 1 FROM fences WHERE session=?").get(sessionId))
			throw new Error("Session is fenced");
	}

	encodeCursor(cursor: Cursor): string {
		const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
		return `${payload}.${createHmac("sha256", this.cursorSecret as string)
			.update(payload)
			.digest("base64url")}`;
	}
	decodeCursor(token: string): Cursor {
		const parts = token.split(".");
		if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid channel cursor");
		const expected = createHmac("sha256", this.cursorSecret as string)
			.update(parts[0])
			.digest();
		const actual = Buffer.from(parts[1], "base64url");
		if (
			actual.length !== expected.length ||
			!timingSafeEqual(expected, actual) ||
			actual.toString("base64url") !== parts[1]
		)
			throw new Error("Invalid channel cursor");
		let value: Cursor;
		try {
			value = JSON.parse(Buffer.from(parts[0], "base64url").toString());
		} catch {
			throw new Error("Invalid channel cursor");
		}
		if (
			value?.version !== 1 ||
			value.type !== "channel-list" ||
			value.id !== this.databaseId ||
			value.project !== this.projectRoot ||
			typeof value.upper !== "string" ||
			!/^(0|[1-9][0-9]*)$/.test(value.upper) ||
			typeof value.after !== "string"
		)
			throw new Error("Invalid channel cursor");
		return value;
	}

	manage(actor: ChannelActor, params: ChannelManageParams): ChannelManageResult {
		if (!actor || typeof actor.sessionId !== "string" || !actor.sessionId.trim())
			throw new Error("Invalid session identity");
		if (
			!params ||
			typeof params !== "object" ||
			!["create", "subscribe", "unsubscribe", "list"].includes(params.action)
		)
			throw new Error("Invalid action");
		const keys = Object.keys(params);
		if (keys.some((key) => !["action", "topic", "scope", "limit", "cursor"].includes(key)))
			throw new Error("Unknown parameter");
		if (params.action === "list") {
			if (
				"topic" in params ||
				(params.scope !== undefined && !["all", "subscribed"].includes(params.scope)) ||
				(params.cursor !== undefined &&
					(typeof params.cursor !== "string" || !params.cursor || "scope" in params)) ||
				(params.limit !== undefined &&
					(!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100))
			)
				throw new Error("Invalid list parameters");
			const all = params.scope === "all" || params.cursor !== undefined;
			if (!all && ("limit" in params || "cursor" in params))
				throw new Error("Subscribed list does not paginate");
			const db = this.open(false);
			if (!db) {
				if (params.cursor) throw new Error("Invalid channel cursor");
				return { channels: [] };
			}
			this.assertActive(actor.sessionId);
			if (!all) return { channels: this.entries(actor.sessionId) };
			const cursor = params.cursor ? this.decodeCursor(params.cursor) : null;
			const upper =
				cursor?.upper ??
				String(db.prepare("SELECT CAST(COALESCE(MAX(id),0) AS TEXT) AS n FROM topics").get()?.n);
			const limit = params.limit ?? 50;
			const rows = db
				.prepare(`SELECT t.topic, CASE WHEN m.active=1 THEN 1 ELSE 0 END AS subscribed,
				(SELECT COUNT(*) FROM messages x WHERE x.topic=t.topic AND x.id>m.position AND x.sender<>?) AS unread
				FROM topics t LEFT JOIN members m ON m.topic=t.topic AND m.session=? WHERE t.id<=CAST(? AS INTEGER) AND t.topic>? COLLATE BINARY ORDER BY t.topic COLLATE BINARY LIMIT ?`)
				.all(actor.sessionId, actor.sessionId, upper, cursor?.after ?? "", limit + 1);
			const more = rows.length > limit;
			const selected = rows.slice(0, limit);
			const channels = selected.map((r) => ({
				topic: String(r.topic),
				subscribed: r.subscribed === 1,
				unread: r.subscribed === 1 ? Number(r.unread) : 0,
			}));
			return {
				channels,
				...(more
					? {
							nextCursor: this.encodeCursor({
								version: 1,
								type: "channel-list",
								id: this.databaseId as string,
								project: this.projectRoot,
								upper,
								after: channels[channels.length - 1]?.topic ?? "",
							}),
						}
					: {}),
			};
		}
		if (keys.some((key) => !["action", "topic"].includes(key)) || typeof params.topic !== "string")
			throw new Error("Invalid management parameters");
		const topic = params.topic.trim();
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(topic)) throw new Error("Invalid channel topic");
		if (params.action !== "create" && !this.open(false)) throw new Error("Channel does not exist");
		return this.transaction((db) => {
			this.assertActive(actor.sessionId, db);
			const exists = db.prepare("SELECT 1 FROM topics WHERE topic=?").get(topic);
			if (params.action === "create" && exists) throw new Error("Channel already exists");
			if (params.action !== "create" && !exists) throw new Error("Channel does not exist");
			const member = db
				.prepare("SELECT active FROM members WHERE topic=? AND session=?")
				.get(topic, actor.sessionId);
			if (params.action !== "unsubscribe" && member?.active !== 1) {
				const count = Number(
					db.prepare("SELECT COUNT(*) AS n FROM members WHERE session=? AND active=1").get(actor.sessionId)
						?.n,
				);
				if (count >= 5) throw new Error("Channel subscription limit reached");
			}
			if (params.action === "create") db.prepare("INSERT INTO topics(topic) VALUES (?)").run(topic);
			if (params.action === "unsubscribe")
				db.prepare("UPDATE members SET active=0 WHERE topic=? AND session=?").run(topic, actor.sessionId);
			else if (member?.active !== 1)
				db.prepare(
					`INSERT INTO members(topic,session,active,epoch,position) VALUES (?,?,1,1,(SELECT COALESCE(MAX(id),0) FROM messages WHERE topic=?)) ON CONFLICT(topic,session) DO UPDATE SET active=1, epoch=epoch+1`,
				).run(topic, actor.sessionId, topic);
			return { channels: this.entries(actor.sessionId, db) };
		});
	}
	private member(db: DatabaseSync, actor: ChannelActor, topic: string) {
		this.assertActive(actor?.sessionId, db);
		const row = db
			.prepare(
				"SELECT active, epoch, CAST(position AS TEXT) AS position FROM members WHERE session=? AND topic=?",
			)
			.get(actor.sessionId, topic);
		if (row?.active !== 1) throw new Error("Channel does not exist or is not subscribed");
		return { epoch: Number(row.epoch), position: String(row.position) };
	}

	private receipt(
		db: DatabaseSync,
		session: string,
		kind: string,
		callId: string,
		params: string,
		epoch?: number,
	): string | null {
		const row = db
			.prepare("SELECT params, epoch, result FROM receipts WHERE session=? AND kind=? AND call_id=?")
			.get(session, kind, callId);
		if (!row) return null;
		if (row.params !== params || (epoch !== undefined && row.epoch !== epoch))
			throw new Error("Channel call receipt conflict or expired membership");
		return String(row.result);
	}

	post(actor: ChannelActor, topic: string, message: string, callId: string): ChannelMessage {
		if (
			typeof topic !== "string" ||
			typeof message !== "string" ||
			/[\uD800-\uDFFF]/u.test(message) ||
			typeof callId !== "string" ||
			!callId.trim()
		)
			throw new Error("Invalid post parameters");
		const body = message.trim();
		if (!body || Array.from(body).length > 1000)
			throw new Error(
				"Message must contain 1–1000 characters; write long content to a file and send its relative path",
			);
		const params = JSON.stringify([topic, message]);
		if (!this.open(false)) throw new Error("Channel does not exist");
		return this.transaction((db) => {
			this.member(db, actor, topic);
			const prior = this.receipt(db, actor.sessionId, "post", callId, params);
			if (prior) return JSON.parse(prior) as ChannelMessage;
			const name = Array.from(actor.sessionName?.trim() || actor.sessionId)
				.slice(0, 128)
				.join("");
			const at = new Date().toISOString();
			db.prepare("INSERT INTO messages(topic,sender,name,at,body) VALUES (?,?,?,?,?)").run(
				topic,
				actor.sessionId,
				name,
				at,
				body,
			);
			const id = String(db.prepare("SELECT CAST(last_insert_rowid() AS TEXT) AS id").get()?.id);
			const result = { id, topic, sender: actor.sessionId, name, at, body };
			db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?)").run(
				actor.sessionId,
				"post",
				callId,
				params,
				null,
				JSON.stringify(result),
			);
			return result;
		});
	}

	private messageCursor(token: string): MessageCursor {
		const parts = token.split(".");
		if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid channel cursor");
		const expected = createHmac("sha256", this.cursorSecret as string)
			.update(parts[0])
			.digest();
		const actual = Buffer.from(parts[1], "base64url");
		if (
			actual.length !== expected.length ||
			!timingSafeEqual(expected, actual) ||
			actual.toString("base64url") !== parts[1]
		)
			throw new Error("Invalid channel cursor");
		let value: MessageCursor;
		try {
			value = JSON.parse(Buffer.from(parts[0], "base64url").toString());
		} catch {
			throw new Error("Invalid channel cursor");
		}
		if (
			value?.version !== 1 ||
			value.type !== "channel-message" ||
			value.id !== this.databaseId ||
			value.project !== this.projectRoot ||
			typeof value.topic !== "string" ||
			!["unread", "recent", "start"].includes(value.mode) ||
			typeof value.upper !== "string" ||
			!/^(0|[1-9][0-9]*)$/.test(value.upper) ||
			typeof value.after !== "string" ||
			!/^(0|[1-9][0-9]*)$/.test(value.after)
		)
			throw new Error("Invalid channel cursor");
		return value;
	}

	read(actor: ChannelActor, params: ChannelReadParams, callId: string): ChannelReadResult {
		if (
			!params ||
			typeof params.topic !== "string" ||
			Object.keys(params).some((key) => !["topic", "mode", "cursor", "limit"].includes(key)) ||
			(params.mode !== undefined && !["unread", "recent", "start"].includes(params.mode)) ||
			(params.cursor !== undefined &&
				(typeof params.cursor !== "string" || !params.cursor || "mode" in params)) ||
			(params.limit !== undefined &&
				(!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) ||
			typeof callId !== "string" ||
			!callId.trim()
		)
			throw new Error("Invalid read parameters");
		const fingerprint = JSON.stringify([
			params.topic,
			params.mode ?? null,
			params.cursor ?? null,
			params.limit ?? null,
		]);
		if (!this.open(false)) throw new Error("Channel does not exist");
		return this.transaction((db) => {
			const member = this.member(db, actor, params.topic);
			const cursor = params.cursor ? this.messageCursor(params.cursor) : null;
			if (
				cursor &&
				(cursor.topic !== params.topic ||
					(cursor.mode === "unread" && (cursor.session !== actor.sessionId || cursor.epoch !== member.epoch)))
			)
				throw new Error("Invalid or expired channel cursor");
			const mode = cursor?.mode ?? params.mode ?? "unread";
			if (mode === "unread") {
				const prior = this.receipt(db, actor.sessionId, "read", callId, fingerprint, member.epoch);
				if (prior) return JSON.parse(prior) as ChannelReadResult;
				if (cursor && cursor.after !== member.position)
					throw new Error("Stale unread cursor; read unread again");
			}
			const upper =
				cursor?.upper ??
				String(
					db
						.prepare("SELECT CAST(COALESCE(MAX(id),0) AS TEXT) AS id FROM messages WHERE topic=?")
						.get(params.topic)?.id,
				);
			const after = cursor?.after ?? (mode === "unread" ? member.position : mode === "recent" ? upper : "0");
			const recent = mode === "recent";
			const rows = db
				.prepare(
					`SELECT CAST(id AS TEXT) AS id, topic, sender, name, at, body FROM messages WHERE topic=? AND id<=CAST(? AS INTEGER) AND id${recent ? (cursor ? "<" : "<=") : ">"}CAST(? AS INTEGER) ${mode === "unread" ? "AND sender<>?" : ""} ORDER BY messages.id ${recent ? "DESC" : "ASC"} LIMIT ?`,
				)
				.all(
					...(mode === "unread"
						? [params.topic, upper, after, actor.sessionId, (params.limit ?? 50) + 1]
						: [params.topic, upper, after, (params.limit ?? 50) + 1]),
				);
			const messages: ChannelMessage[] = [];
			let size = 0;
			let stopReason: ChannelReadResult["stopReason"] = "end";
			for (const row of rows) {
				if (messages.length === (params.limit ?? 50)) {
					stopReason = "limit";
					break;
				}
				const length = Array.from(String(row.body)).length;
				if (size + length > 12000) {
					stopReason = "budget";
					break;
				}
				size += length;
				messages.push({
					id: String(row.id),
					topic: String(row.topic),
					sender: String(row.sender),
					name: String(row.name),
					at: String(row.at),
					body: String(row.body),
				});
			}
			const hasMore = stopReason !== "end";
			let position = messages.at(-1)?.id ?? after;
			if (mode === "unread") {
				if (!hasMore && BigInt(upper) > BigInt(position)) position = upper;
				db.prepare("UPDATE members SET position=CAST(? AS INTEGER) WHERE session=? AND topic=?").run(
					position,
					actor.sessionId,
					params.topic,
				);
			}
			const next: MessageCursor = {
				version: 1,
				type: "channel-message",
				id: this.databaseId as string,
				project: this.projectRoot,
				topic: params.topic,
				mode,
				upper,
				after: position,
				...(mode === "unread" ? { session: actor.sessionId, epoch: member.epoch } : {}),
			};
			const payload = Buffer.from(JSON.stringify(next)).toString("base64url");
			const nextCursor = `${payload}.${createHmac("sha256", this.cursorSecret as string)
				.update(payload)
				.digest("base64url")}`;
			if (recent) messages.reverse();
			const unread = Number(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM messages WHERE topic=? AND id>(SELECT position FROM members WHERE topic=? AND session=?) AND sender<>?",
					)
					.get(params.topic, params.topic, actor.sessionId, actor.sessionId)?.n,
			);
			const result: ChannelReadResult = {
				mode,
				messages,
				direction: recent ? "older" : "newer",
				upper,
				count: messages.length,
				stopReason,
				hasMore,
				...(hasMore ? { nextCursor } : {}),
				unread,
			};
			if (mode === "unread")
				db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?)").run(
					actor.sessionId,
					"read",
					callId,
					fingerprint,
					member.epoch,
					JSON.stringify(result),
				);
			return result;
		});
	}

	prepareMaintenance(sessionId: string, opId: string, kind: "archive" | "delete", source: string): void {
		if (!sessionId?.trim() || !opId?.trim() || !source?.trim() || !["archive", "delete"].includes(kind))
			throw new Error("Invalid maintenance parameters");
		this.transaction((db) => {
			if (db.prepare("SELECT 1 FROM maintenance_history WHERE session=? AND op=?").get(sessionId, opId))
				throw new Error("Maintenance operation already completed");
			const existing = db.prepare("SELECT state,op,source FROM fences WHERE session=?").get(sessionId);
			if (existing) {
				if (
					existing.op === opId &&
					existing.source === source &&
					(existing.state === kind ||
						(kind === "archive" && existing.state === "archived") ||
						(kind === "delete" && existing.state === "deleted"))
				)
					return;
				if (
					!(
						existing.state === "archived" &&
						kind === "delete" &&
						existing.op !== opId &&
						existing.source === source
					)
				)
					throw new Error("Conflicting maintenance fence");
			}
			db.prepare(
				"INSERT INTO fences(session,state,op,source) VALUES (?,?,?,?) ON CONFLICT(session) DO UPDATE SET state=excluded.state,op=excluded.op,source=excluded.source",
			).run(sessionId, kind, opId, source);
			db.prepare("UPDATE members SET active=0 WHERE session=?").run(sessionId);
		});
	}

	completeMaintenance(sessionId: string, opId: string, outcome: "archived" | "active" | "deleted"): void {
		if (!sessionId?.trim() || !opId?.trim() || !["archived", "active", "deleted"].includes(outcome))
			throw new Error("Invalid maintenance parameters");
		this.transaction((db) => {
			const fence = db.prepare("SELECT state,op FROM fences WHERE session=?").get(sessionId);
			if (
				!fence &&
				outcome === "active" &&
				db.prepare("SELECT 1 FROM maintenance_history WHERE session=? AND op=?").get(sessionId, opId)
			)
				return;
			if (!fence || fence.op !== opId || (fence.state === "deleted" && outcome !== "deleted"))
				throw new Error("Conflicting maintenance fence");
			if (outcome === "active" && (fence.state === "archive" || fence.state === "archived")) {
				db.prepare("INSERT OR IGNORE INTO maintenance_history VALUES (?,?)").run(sessionId, opId);
				db.prepare("DELETE FROM fences WHERE session=?").run(sessionId);
			} else if (outcome === "archived" && (fence.state === "archive" || fence.state === "archived"))
				db.prepare("UPDATE fences SET state='archived' WHERE session=?").run(sessionId);
			else if (outcome === "deleted" && (fence.state === "delete" || fence.state === "deleted")) {
				db.prepare("DELETE FROM members WHERE session=?").run(sessionId);
				db.prepare("DELETE FROM receipts WHERE session=?").run(sessionId);
				db.prepare("UPDATE fences SET state='deleted' WHERE session=?").run(sessionId);
			} else throw new Error("Conflicting maintenance outcome");
		});
	}

	pendingMaintenance(): ChannelFence[] {
		const db = this.open(false);
		if (!db) return [];
		return db
			.prepare("SELECT session,op,source,state FROM fences ORDER BY session")
			.all()
			.map((row) => ({
				sessionId: String(row.session),
				opId: String(row.op),
				source: String(row.source),
				state: row.state as ChannelFence["state"],
				kind: row.state === "archive" || row.state === "archived" ? "archive" : "delete",
			}));
	}

	entries(sessionId: string, currentDb?: DatabaseSync): ChannelEntry[] {
		const db = currentDb ?? this.open(false);
		if (!db) return [];
		return db
			.prepare(
				`SELECT m.topic, (SELECT COUNT(*) FROM messages x WHERE x.topic=m.topic AND x.id>m.position AND x.sender<>m.session) AS unread FROM members m WHERE m.session=? AND m.active=1 ORDER BY m.topic COLLATE BINARY`,
			)
			.all(sessionId)
			.map((r) => ({ topic: String(r.topic), subscribed: true, unread: Number(r.unread) }));
	}
	snapshot(sessionId: string): ChannelSnapshotEntry[] {
		this.assertActive(sessionId);
		return this.entries(sessionId).map(({ topic, unread }) => ({ topic, unread }));
	}
	close(): void {
		this.db?.close();
		this.db = null;
		this.databaseId = null;
		this.cursorSecret = null;
		this.fileIdentity = null;
	}
}
