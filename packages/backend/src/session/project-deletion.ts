import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type {
	SessionMeta,
	SessionProjectDeletionPreview,
	SessionProjectDeletionResult,
} from "@percho/shared";
import type { SessionCatalog } from "./catalog.js";

type Candidate = { meta: SessionMeta; file: string; fingerprint: string; loaded?: object };
type Plan = { cwd: string; expires: number; candidates: Candidate[] };

/** Coordinates confirmation and deletion; the owner must gate project mutations with isDeleting. */
export class SessionProjectDeletion {
	private readonly tokens = new Map<string, Plan>();
	private readonly active = new Set<string>();
	constructor(
		private readonly options: {
			catalog: () => SessionCatalog;
			getLoaded: () => SessionMeta[];
			loadedIdentity?: (sessionId: string) => object | undefined;
			deleteSession: (sessionId: string, sessionFile: string) => Promise<void>;
			isProtected: (cwd: string) => boolean;
			isBusy: (sessionId: string) => boolean;
			freeze?: (sessionId: string) => () => void;
		},
	) {}

	private cwd(value: string): string {
		if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))
			throw new Error("Invalid project path");
		const cwd = normalize(value);
		if (this.options.isProtected(cwd)) throw new Error("Protected project");
		return cwd;
	}

	isDeleting(cwd: string): boolean {
		return (
			typeof cwd === "string" && isAbsolute(cwd) && !cwd.includes("\0") && this.active.has(normalize(cwd))
		);
	}

	private async fingerprint(file: string): Promise<string | null> {
		if (!file) return null;
		try {
			const s = await lstat(file, { bigint: true });
			if (!s.isFile()) throw new Error("Session source is not a regular file");
			return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private async check(candidate: Candidate, cwd: string, catalog: SessionCatalog): Promise<void> {
		const { meta, file, loaded } = candidate;
		if (loaded) {
			if (
				(this.options.loadedIdentity
					? this.options.loadedIdentity(meta.sessionId) !== loaded
					: !this.options.getLoaded().some((item) => item === loaded)) ||
				meta.cwd !== cwd ||
				(meta.sessionFile ?? "") !== file
			)
				throw new Error("Loaded session changed; confirm again");
			const [verification] = await catalog.verify([{ sessionId: meta.sessionId }]);
			if (verification?.status !== "missing" || (await this.fingerprint(file)) !== null)
				throw new Error("Loaded session source changed; confirm again");
		} else {
			const [verification] = await catalog.verify([{ sessionId: meta.sessionId, sessionFile: file }]);
			if (
				!verification ||
				(!["present", "archived"].includes(verification.status) &&
					!(
						candidate.fingerprint === "missing-archived" &&
						verification.status === "missing" &&
						verification.meta?.archivedAt != null
					)) ||
				verification.meta?.cwd !== cwd ||
				verification.meta.sessionFile !== file ||
				verification.meta.sessionId !== meta.sessionId
			)
				throw new Error("Session source cannot be verified; confirm again");
			const fingerprint = await this.fingerprint(file);
			if (
				candidate.fingerprint === "missing-archived"
					? fingerprint !== null
					: fingerprint !== candidate.fingerprint
			)
				throw new Error("Session source changed; confirm again");
		}
	}

	private async collect(cwd: string): Promise<Candidate[]> {
		const catalog = this.options.catalog();
		await catalog.refresh();
		const projects = await catalog.projects();
		if (!projects.complete || projects.errors) throw new Error("Incomplete session catalog");
		const candidates: Candidate[] = [];
		const ids = new Map<string, string>();
		for (const archived of [false, true]) {
			let cursor: string | undefined;
			do {
				const page = await catalog.query({ cwd, archived, sort: "modified", limit: 100, cursor });
				if (!page.complete || page.errors || page.revision !== projects.revision)
					throw new Error("Incomplete or changed session catalog");
				for (const meta of page.sessions) {
					const file = meta.sessionFile;
					if (!file || meta.cwd !== cwd || ids.has(meta.sessionId))
						throw new Error("Ambiguous session catalog");
					ids.set(meta.sessionId, file);
					const [verification] = await catalog.verify([{ sessionId: meta.sessionId, sessionFile: file }]);
					if (
						!verification ||
						(!["present", "archived"].includes(verification.status) &&
							!(verification.status === "missing" && meta.archivedAt != null)) ||
						verification.meta?.cwd !== cwd ||
						verification.meta.sessionFile !== file ||
						verification.meta.sessionId !== meta.sessionId
					)
						throw new Error("Session source cannot be verified");
					const fingerprint = await this.fingerprint(file);
					if (fingerprint === null && !(verification.status === "missing" && meta.archivedAt != null))
						throw new Error("Session source missing");
					const candidate = { meta, file, fingerprint: fingerprint ?? "missing-archived" };
					await this.check(candidate, cwd, catalog);
					candidates.push(candidate);
				}
				cursor = page.nextCursor;
			} while (cursor);
		}
		for (const meta of this.options.getLoaded()) {
			if (meta.cwd !== cwd) continue;
			const file = meta.sessionFile ?? "";
			if (ids.has(meta.sessionId)) {
				if (ids.get(meta.sessionId) !== file) throw new Error("Duplicate session ID");
				continue;
			}
			const candidate = {
				meta: { ...meta },
				file,
				fingerprint: "missing",
				loaded: this.options.loadedIdentity?.(meta.sessionId) ?? meta,
			};
			await this.check(candidate, cwd, catalog);
			ids.set(meta.sessionId, file);
			candidates.push(candidate);
		}
		return candidates.sort(
			(a, b) => a.meta.sessionId.localeCompare(b.meta.sessionId) || a.file.localeCompare(b.file),
		);
	}

	async preview(path: string): Promise<SessionProjectDeletionPreview> {
		const cwd = this.cwd(path);
		if (this.active.has(cwd)) throw new Error("Project deletion in progress");
		const candidates = await this.collect(cwd);
		if (this.active.has(cwd)) throw new Error("Project deletion in progress");
		const now = Date.now();
		for (const [key, plan] of this.tokens) if (plan.expires <= now) this.tokens.delete(key);
		while (this.tokens.size >= 100) this.tokens.delete(this.tokens.keys().next().value as string);
		const token = randomUUID();
		this.tokens.set(token, { cwd, expires: now + 120_000, candidates });
		return {
			cwd,
			token,
			sessionCount: candidates.length,
			archivedCount: candidates.filter((c) => c.meta.archivedAt != null).length,
		};
	}

	async delete(path: string, token: string): Promise<SessionProjectDeletionResult> {
		const cwd = this.cwd(path);
		const plan = this.tokens.get(token);
		this.tokens.delete(token);
		if (!plan || plan.cwd !== cwd || plan.expires <= Date.now())
			throw new Error("Invalid or expired confirmation token");
		if (this.active.has(cwd)) throw new Error("Project deletion in progress");
		this.active.add(cwd);
		const releases: Array<() => void> = [];
		try {
			const current = await this.collect(cwd);
			if (
				current.length !== plan.candidates.length ||
				current.some((c, i) => {
					const previous = plan.candidates[i];
					return (
						!previous ||
						c.meta.sessionId !== previous.meta.sessionId ||
						c.file !== previous.file ||
						c.fingerprint !== previous.fingerprint ||
						c.loaded !== previous.loaded ||
						c.meta.archiveRevision !== previous.meta.archiveRevision ||
						c.meta.archivedAt !== previous.meta.archivedAt ||
						c.meta.archiveCleanupPending !== previous.meta.archiveCleanupPending
					);
				})
			)
				throw new Error("Project sessions changed; confirm again");
			if (current.some((c) => this.options.isBusy(c.meta.sessionId)))
				throw new Error("Project contains busy sessions");
			for (const candidate of current) {
				const release = this.options.freeze?.(candidate.meta.sessionId);
				if (release) releases.push(release);
			}
			const result: SessionProjectDeletionResult = { deleted: [], failed: [] };
			for (const candidate of current) {
				try {
					if (this.options.isBusy(candidate.meta.sessionId)) throw new Error("Session is busy");
					await this.check(candidate, cwd, this.options.catalog());
					await this.options.deleteSession(candidate.meta.sessionId, candidate.file);
					result.deleted.push(candidate.meta.sessionId);
				} catch (error) {
					result.failed.push({
						sessionId: candidate.meta.sessionId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return result;
		} finally {
			for (const release of releases.reverse()) release();
			this.active.delete(cwd);
		}
	}
}
