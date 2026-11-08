import type { SessionMeta } from "./session";

export type SessionCatalogSort = "archived" | "modified" | "created" | "name";

export interface SessionCatalogQuery {
	cwd?: string;
	search?: string;
	archived?: boolean;
	sort?: SessionCatalogSort;
	limit?: number;
	cursor?: string;
}

export interface SessionCatalogPage {
	sessions: SessionMeta[];
	nextCursor?: string;
	revision: string;
	complete: boolean;
	errors: number;
	total?: number;
}

export interface SessionCatalogProject {
	cwd: string;
	sessionCount: number;
	archivedCount: number;
	lastActive: number;
}

export interface SessionCatalogProjects {
	projects: SessionCatalogProject[];
	revision: string;
	complete: boolean;
	errors: number;
}

export interface SessionCatalogReference {
	sessionId?: string;
	sessionFile?: string;
}

export interface SessionCatalogVerification {
	reference: SessionCatalogReference;
	status: "present" | "archived" | "missing" | "unknown" | "ambiguous";
	meta?: SessionMeta;
	error?: string;
}

export interface SessionArchiveInput {
	sessionId: string;
	sessionFile: string;
	expectedRevision: number;
}

export interface SessionArchiveResult {
	sessionId: string;
	sessionFile: string;
	archived: boolean;
	revision: number;
	archivedAt?: number;
	cleanupPending?: boolean;
}

export interface SessionProjectDeletionPreview {
	cwd: string;
	token: string;
	sessionCount: number;
	archivedCount: number;
}

export interface SessionProjectDeletionResult {
	deleted: string[];
	failed: Array<{ sessionId: string; error: string }>;
}

export interface SessionCatalogChange {
	revision: string;
	complete: boolean;
}
