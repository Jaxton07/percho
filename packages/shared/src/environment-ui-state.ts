import { environmentEntityRef, sameEnvironment } from "./environment";
import type { SessionMeta } from "./session";

/** Navigation references only. No transcripts, credentials, permissions or draft contents. */
export interface EnvironmentUiState {
	version: 1;
	projects: string[];
	dailyDirs: string[];
	pinnedSessions: string[];
	pinnedProjects: string[];
	expandedGroups: string[];
	expandedGroupsTouched: boolean;
	lastCwd: string | null;
	workspace: {
		members: { file: string; sessionId: string }[];
		activeFile: string | null;
		recentFile: string | null;
	};
	catalog: SessionMeta[];
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid navigation record");
	return value as Record<string, unknown>;
}
function identity(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 32768)
		throw new Error("Invalid navigation identity");
	environmentEntityRef(value);
	return value;
}
function identities(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 10000) throw new Error("Invalid navigation list");
	return [...new Set(value.map(identity))];
}
function nullableIdentity(value: unknown): string | null {
	return value === null ? null : identity(value);
}
export function parseEnvironmentUiState(value: unknown): EnvironmentUiState | null {
	try {
		const raw = record(value),
			workspace = record(raw.workspace);
		if (raw.version !== 1 || typeof raw.expandedGroupsTouched !== "boolean") return null;
		if (
			!Array.isArray(workspace.members) ||
			workspace.members.length > 10000 ||
			!Array.isArray(raw.catalog) ||
			raw.catalog.length > 10000
		)
			return null;
		const files = new Set<string>(),
			ids = new Set<string>();
		const members = workspace.members.map((item) => {
			const member = record(item),
				file = identity(member.file),
				sessionId = identity(member.sessionId);
			if (
				!sameEnvironment(
					environmentEntityRef(file).environment,
					environmentEntityRef(sessionId).environment,
				) ||
				files.has(file) ||
				ids.has(sessionId)
			)
				throw new Error("Inconsistent navigation member");
			files.add(file);
			ids.add(sessionId);
			return { file, sessionId };
		});
		const catalog = raw.catalog.map((item): SessionMeta => {
			const meta = record(item),
				sessionId = identity(meta.sessionId),
				cwd = identity(meta.cwd);
			const sessionFile = meta.sessionFile === undefined ? undefined : identity(meta.sessionFile);
			const env = environmentEntityRef(sessionId).environment;
			if (
				!sameEnvironment(env, environmentEntityRef(cwd).environment) ||
				(sessionFile && !sameEnvironment(env, environmentEntityRef(sessionFile).environment))
			)
				throw new Error("Inconsistent navigation source");
			if (
				typeof meta.createdAt !== "number" ||
				!Number.isFinite(meta.createdAt) ||
				typeof meta.messageCount !== "number" ||
				!Number.isFinite(meta.messageCount)
			)
				throw new Error("Invalid navigation metadata");
			return {
				sessionId,
				cwd,
				sessionFile,
				name: typeof meta.name === "string" ? meta.name.slice(0, 1000) : undefined,
				active: false,
				messageCount: Math.max(0, meta.messageCount),
				createdAt: meta.createdAt,
				modifiedAt:
					typeof meta.modifiedAt === "number" && Number.isFinite(meta.modifiedAt)
						? meta.modifiedAt
						: undefined,
			};
		});
		const activeFile = nullableIdentity(workspace.activeFile),
			recentFile = nullableIdentity(workspace.recentFile);
		return {
			version: 1,
			projects: identities(raw.projects),
			dailyDirs: identities(raw.dailyDirs ?? []),
			pinnedSessions: identities(raw.pinnedSessions),
			pinnedProjects: identities(raw.pinnedProjects),
			expandedGroups: identities(raw.expandedGroups),
			expandedGroupsTouched: raw.expandedGroupsTouched,
			lastCwd: nullableIdentity(raw.lastCwd),
			workspace: {
				members,
				activeFile: activeFile && files.has(activeFile) ? activeFile : null,
				recentFile: recentFile && files.has(recentFile) ? recentFile : null,
			},
			catalog,
		};
	} catch {
		return null;
	}
}
