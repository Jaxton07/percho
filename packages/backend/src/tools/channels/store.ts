import { createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ChannelDatabase } from "./database";
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
	private readonly database: ChannelDatabase;
	private readonly ownsDatabase: boolean;

	constructor(options: { projectRoot: string; agentDir: string; database?: ChannelDatabase }) {
		if (!isAbsolute(options.projectRoot)) throw new Error("Project root must be an absolute path");
		this.projectRoot = resolve(options.projectRoot);
		this.ownsDatabase = !options.database;
		this.database = options.database ?? new ChannelDatabase({ agentDir: options.agentDir });
	}

	get databasePath() {
		return this.database.databasePath;
	}
	get markerPath() {
		return this.database.markerPath;
	}
	private get databaseId() {
		return this.database.databaseId;
	}
	private get cursorSecret() {
		return this.database.cursorSecret;
	}
	open(create = false): DatabaseSync | null {
		return this.database.open(create);
	}

	transaction<T>(fn: (db: DatabaseSync) => T, write = true): T {
		return this.database.transaction(fn, write);
	}

	assertActive(sessionId: string, currentDb?: DatabaseSync): void {
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid session identity");
		const db = currentDb ?? this.open(false);
		if (db?.prepare("SELECT 1 FROM fences WHERE project=? AND session=?").get(this.projectRoot, sessionId))
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
				String(
					db
						.prepare("SELECT CAST(COALESCE(MAX(id),0) AS TEXT) AS n FROM topics WHERE project=?")
						.get(this.projectRoot)?.n,
				);
			const limit = params.limit ?? 50;
			const rows = db
				.prepare(`SELECT t.topic, CASE WHEN m.active=1 THEN 1 ELSE 0 END AS subscribed,
				(SELECT COUNT(*) FROM messages x WHERE x.project=t.project AND x.topic=t.topic AND x.id>m.position AND x.sender<>?) AS unread
				FROM topics t LEFT JOIN members m ON m.project=t.project AND m.topic=t.topic AND m.session=? WHERE t.project=? AND t.id<=CAST(? AS INTEGER) AND t.topic>? COLLATE BINARY ORDER BY t.topic COLLATE BINARY LIMIT ?`)
				.all(actor.sessionId, actor.sessionId, this.projectRoot, upper, cursor?.after ?? "", limit + 1);
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
			const exists = db
				.prepare("SELECT 1 FROM topics WHERE project=? AND topic=?")
				.get(this.projectRoot, topic);
			if (params.action === "create" && exists) throw new Error("Channel already exists");
			if (params.action !== "create" && !exists) throw new Error("Channel does not exist");
			const member = db
				.prepare("SELECT active FROM members WHERE project=? AND topic=? AND session=?")
				.get(this.projectRoot, topic, actor.sessionId);
			if (params.action !== "unsubscribe" && member?.active !== 1) {
				const count = Number(
					db
						.prepare("SELECT COUNT(*) AS n FROM members WHERE project=? AND session=? AND active=1")
						.get(this.projectRoot, actor.sessionId)?.n,
				);
				if (count >= 5) throw new Error("Channel subscription limit reached");
			}
			if (params.action === "create")
				db.prepare("INSERT INTO topics(project,topic) VALUES (?,?)").run(this.projectRoot, topic);
			if (params.action === "unsubscribe")
				db.prepare("UPDATE members SET active=0 WHERE project=? AND topic=? AND session=?").run(
					this.projectRoot,
					topic,
					actor.sessionId,
				);
			else if (member?.active !== 1)
				db.prepare(
					`INSERT INTO members(project,topic,session,active,epoch,position) VALUES (?,?,?,1,1,(SELECT COALESCE(MAX(id),0) FROM messages WHERE project=? AND topic=?)) ON CONFLICT(project,topic,session) DO UPDATE SET active=1, epoch=epoch+1`,
				).run(this.projectRoot, topic, actor.sessionId, this.projectRoot, topic);
			return { channels: this.entries(actor.sessionId, db) };
		});
	}
	private member(db: DatabaseSync, actor: ChannelActor, topic: string) {
		this.assertActive(actor?.sessionId, db);
		const row = db
			.prepare(
				"SELECT active, epoch, CAST(position AS TEXT) AS position FROM members WHERE project=? AND session=? AND topic=?",
			)
			.get(this.projectRoot, actor.sessionId, topic);
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
			.prepare(
				"SELECT params, epoch, result FROM receipts WHERE project=? AND session=? AND kind=? AND call_id=?",
			)
			.get(this.projectRoot, session, kind, callId);
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
			db.prepare("INSERT INTO messages(project,topic,sender,name,at,body) VALUES (?,?,?,?,?,?)").run(
				this.projectRoot,
				topic,
				actor.sessionId,
				name,
				at,
				body,
			);
			const id = String(db.prepare("SELECT CAST(last_insert_rowid() AS TEXT) AS id").get()?.id);
			const result = { id, topic, sender: actor.sessionId, name, at, body };
			db.prepare(
				"INSERT INTO receipts(project,session,kind,call_id,params,epoch,result) VALUES (?,?,?,?,?,?,?)",
			).run(this.projectRoot, actor.sessionId, "post", callId, params, null, JSON.stringify(result));
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
		const cursor = params.cursor ? this.messageCursor(params.cursor) : null;
		const mode = cursor?.mode ?? params.mode ?? "unread";
		return this.transaction((db) => {
			const member = this.member(db, actor, params.topic);
			if (
				cursor &&
				(cursor.topic !== params.topic ||
					(cursor.mode === "unread" && (cursor.session !== actor.sessionId || cursor.epoch !== member.epoch)))
			)
				throw new Error("Invalid or expired channel cursor");
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
						.prepare(
							"SELECT CAST(COALESCE(MAX(id),0) AS TEXT) AS id FROM messages WHERE project=? AND topic=?",
						)
						.get(this.projectRoot, params.topic)?.id,
				);
			const after = cursor?.after ?? (mode === "unread" ? member.position : mode === "recent" ? upper : "0");
			const recent = mode === "recent";
			const rows = db
				.prepare(
					`SELECT CAST(id AS TEXT) AS id, topic, sender, name, at, body FROM messages WHERE project=? AND topic=? AND id<=CAST(? AS INTEGER) AND id${recent ? (cursor ? "<" : "<=") : ">"}CAST(? AS INTEGER) ${mode === "unread" ? "AND sender<>?" : ""} ORDER BY messages.id ${recent ? "DESC" : "ASC"} LIMIT ?`,
				)
				.all(
					...(mode === "unread"
						? [this.projectRoot, params.topic, upper, after, actor.sessionId, (params.limit ?? 50) + 1]
						: [this.projectRoot, params.topic, upper, after, (params.limit ?? 50) + 1]),
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
				db.prepare(
					"UPDATE members SET position=CAST(? AS INTEGER) WHERE project=? AND session=? AND topic=?",
				).run(position, this.projectRoot, actor.sessionId, params.topic);
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
						"SELECT COUNT(*) AS n FROM messages WHERE project=? AND topic=? AND id>(SELECT position FROM members WHERE project=? AND topic=? AND session=?) AND sender<>?",
					)
					.get(
						this.projectRoot,
						params.topic,
						this.projectRoot,
						params.topic,
						actor.sessionId,
						actor.sessionId,
					)?.n,
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
				db.prepare(
					"INSERT INTO receipts(project,session,kind,call_id,params,epoch,result) VALUES (?,?,?,?,?,?,?)",
				).run(
					this.projectRoot,
					actor.sessionId,
					"read",
					callId,
					fingerprint,
					member.epoch,
					JSON.stringify(result),
				);
			return result;
		}, mode === "unread");
	}

	prepareMaintenance(sessionId: string, opId: string, kind: "archive" | "delete", source: string): void {
		if (!sessionId?.trim() || !opId?.trim() || !source?.trim() || !["archive", "delete"].includes(kind))
			throw new Error("Invalid maintenance parameters");
		this.transaction((db) => {
			if (
				db
					.prepare("SELECT 1 FROM maintenance_history WHERE project=? AND session=? AND op=?")
					.get(this.projectRoot, sessionId, opId)
			)
				throw new Error("Maintenance operation already completed");
			const existing = db
				.prepare("SELECT state,op,source FROM fences WHERE project=? AND session=?")
				.get(this.projectRoot, sessionId);
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
				"INSERT INTO fences(project,session,state,op,source) VALUES (?,?,?,?,?) ON CONFLICT(project,session) DO UPDATE SET state=excluded.state,op=excluded.op,source=excluded.source",
			).run(this.projectRoot, sessionId, kind, opId, source);
			db.prepare("UPDATE members SET active=0 WHERE project=? AND session=?").run(
				this.projectRoot,
				sessionId,
			);
		});
	}

	completeMaintenance(sessionId: string, opId: string, outcome: "archived" | "active" | "deleted"): void {
		if (!sessionId?.trim() || !opId?.trim() || !["archived", "active", "deleted"].includes(outcome))
			throw new Error("Invalid maintenance parameters");
		this.transaction((db) => {
			const fence = db
				.prepare("SELECT state,op FROM fences WHERE project=? AND session=?")
				.get(this.projectRoot, sessionId);
			if (
				!fence &&
				outcome === "active" &&
				db
					.prepare("SELECT 1 FROM maintenance_history WHERE project=? AND session=? AND op=?")
					.get(this.projectRoot, sessionId, opId)
			)
				return;
			if (!fence || fence.op !== opId || (fence.state === "deleted" && outcome !== "deleted"))
				throw new Error("Conflicting maintenance fence");
			if (outcome === "active" && (fence.state === "archive" || fence.state === "archived")) {
				db.prepare("INSERT OR IGNORE INTO maintenance_history(project,session,op) VALUES (?,?,?)").run(
					this.projectRoot,
					sessionId,
					opId,
				);
				db.prepare("DELETE FROM fences WHERE project=? AND session=?").run(this.projectRoot, sessionId);
			} else if (outcome === "archived" && (fence.state === "archive" || fence.state === "archived"))
				db.prepare("UPDATE fences SET state='archived' WHERE project=? AND session=?").run(
					this.projectRoot,
					sessionId,
				);
			else if (outcome === "deleted" && (fence.state === "delete" || fence.state === "deleted")) {
				db.prepare("DELETE FROM members WHERE project=? AND session=?").run(this.projectRoot, sessionId);
				db.prepare("DELETE FROM receipts WHERE project=? AND session=?").run(this.projectRoot, sessionId);
				db.prepare("UPDATE fences SET state='deleted' WHERE project=? AND session=?").run(
					this.projectRoot,
					sessionId,
				);
			} else throw new Error("Conflicting maintenance outcome");
		});
	}

	pendingMaintenance(): ChannelFence[] {
		const db = this.open(false);
		if (!db) return [];
		return db
			.prepare("SELECT session,op,source,state FROM fences WHERE project=? ORDER BY session")
			.all(this.projectRoot)
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
				`SELECT m.topic, (SELECT COUNT(*) FROM messages x WHERE x.project=m.project AND x.topic=m.topic AND x.id>m.position AND x.sender<>m.session) AS unread FROM members m WHERE m.project=? AND m.session=? AND m.active=1 ORDER BY m.topic COLLATE BINARY`,
			)
			.all(this.projectRoot, sessionId)
			.map((r) => ({ topic: String(r.topic), subscribed: true, unread: Number(r.unread) }));
	}
	snapshot(sessionId: string): ChannelSnapshotEntry[] {
		this.assertActive(sessionId);
		return this.entries(sessionId).map(({ topic, unread }) => ({ topic, unread }));
	}
	close(): void {
		if (this.ownsDatabase) this.database.close();
	}
}
