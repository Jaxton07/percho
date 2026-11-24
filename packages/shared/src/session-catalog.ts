import type { SessionMeta } from "./session";

export type SessionCatalogSort = "archived" | "modified" | "created" | "name";

export interface SessionCatalogScan {
	id: string;
	startedAt: number;
	elapsedMs?: number;
}
export interface SessionCatalogDiagnostics {
	revision?: string;
	errors: number;
	reasons: Record<string, number>;
}

export interface SessionCatalogQuery {
	cwd?: string;
	search?: string;
	archived?: boolean;
	sort?: SessionCatalogSort;
	limit?: number;
	cursor?: string;
	refresh?: boolean;
}

export interface SessionCatalogPage {
	sessions: SessionMeta[];
	nextCursor?: string;
	revision: string;
	complete: boolean;
	errors: number;
	scan?: SessionCatalogScan | null;
	diagnostics?: SessionCatalogDiagnostics;
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
	scan?: SessionCatalogScan | null;
	diagnostics?: SessionCatalogDiagnostics;
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
	scan?: SessionCatalogScan | null;
	diagnostics?: SessionCatalogDiagnostics;
}
