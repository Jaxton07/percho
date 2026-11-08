import {
	environmentEntityRef,
	environmentKey,
	type SessionCatalogVerification,
	type SessionMeta,
} from "@percho/shared";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getExecutionApi } from "../../environment-api";
import { getEnvironments, onEnvironmentsChanged } from "../../environment-registry";
import { getDailyDirsCached, isDailyCwd } from "../../lib/daily";
import { pathLastSegment } from "../../lib/path-display";
import { deriveSidebarGroups } from "../../lib/sidebar-groups";
import { useLocalSessionsStore } from "../../stores/local-sessions";
import { type ProjectEntry, useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { sessionCatalogPageKey, useSessionCatalogStore } from "../../stores/session-catalog";
import { useSessionsStore } from "../../stores/sessions";

export function usePagedSidebar(input: {
	addedProjects: string[];
	activeCwd: string | null;
	pinnedSessions: string[];
	pinnedProjects: string[];
	expandedGroups: string[];
	expandedGroupsTouched: boolean;
}) {
	const environments = useSyncExternalStore(onEnvironmentsChanged, getEnvironments);
	const connectedEnvironment = useRemoteConnectionStore((s) =>
		s.status.state === "connected" && s.status.environment ? environmentKey(s.status.environment) : undefined,
	);
	const watchedEnvironments = useMemo(
		() =>
			environments.filter(
				(environment) => environment.kind === "local" || environmentKey(environment) === connectedEnvironment,
			),
		[environments, connectedEnvironment],
	);
	const catalogs = useSessionCatalogStore((s) => s.byEnvironment);
	const memory = useSessionsStore((s) => s.sessions);
	const known = useProjectsStore((s) => s.allSessions);
	const local = useLocalSessionsStore((s) => s.pending);
	const catalogRevision = environments
		.map((environment) => catalogs[environmentKey(environment)]?.projects?.revision ?? "")
		.join("|");
	const verificationRevision = useRef(catalogRevision);
	verificationRevision.current = catalogRevision;
	const search = useProjectsStore((s) => s.search).trim();
	useEffect(() => {
		useSessionCatalogStore.getState().retainSidebarSearch(search);
	}, [search]);
	const pending = useRef(new Set<string>());
	// Only remember unpersisted rows observed in memory, not the historical directory.
	for (const session of [...memory.filter((s) => !s.sessionFile), ...Object.values(local)])
		if (!session.archivedAt) pending.current.add(session.sessionId);
	for (const id of pending.current) {
		const item =
			known.find((session) => session.sessionId === id) ??
			memory.find((session) => session.sessionId === id) ??
			local[id];
		if (
			!item ||
			item.archivedAt ||
			(!local[id] && item.sessionFile) ||
			Object.values(catalogs).some((catalog) =>
				Object.values(catalog.pages).some((page) =>
					page.sessions.some((session) => session.sessionId === id),
				),
			)
		)
			pending.current.delete(id);
	}
	const [verified, setVerified] = useState<SessionMeta[]>([]);
	useEffect(() => {
		const unwatch = watchedEnvironments.map((environment) =>
			useSessionCatalogStore.getState().watch(environment),
		);
		return () => {
			for (const off of unwatch) off();
		};
	}, [watchedEnvironments]);
	useEffect(() => {
		let active = true;
		setVerified([]);
		void Promise.all(
			environments.map(async (environment) => {
				const references = [...new Set([...input.pinnedSessions, ...Object.keys(local)])]
					.filter(
						(id) => environmentKey(environmentEntityRef(id).environment) === environmentKey(environment),
					)
					.map((sessionId) => ({ sessionId }));
				if (!references.length) return [];
				const api: unknown = getExecutionApi(environment);
				if (
					typeof api !== "object" ||
					api === null ||
					!("verifySessionCatalog" in api) ||
					typeof api.verifySessionCatalog !== "function"
				)
					return [];
				const verify = api.verifySessionCatalog;
				const batches = [];
				for (let offset = 0; offset < references.length; offset += 100)
					batches.push(references.slice(offset, offset + 100));
				const results = await Promise.all(
					batches.map(async (batch) => {
						try {
							return (await verify({ references: batch })) as SessionCatalogVerification[];
						} catch {
							return [];
						}
					}),
				);
				if (!active || verificationRevision.current !== catalogRevision) return [];
				for (const item of results.flat())
					if ((item.status === "archived" || item.status === "missing") && item.reference.sessionId)
						useLocalSessionsStore.getState().forget(item.reference.sessionId);
				return results.flatMap((batch) =>
					batch.flatMap((item) => (item.status === "present" && item.meta ? [item.meta] : [])),
				);
			}),
		).then((results) => {
			if (active && verificationRevision.current === catalogRevision) setVerified(results.flat());
		});
		return () => {
			active = false;
		};
	}, [environments, input.pinnedSessions, catalogRevision, local]);
	useEffect(() => {
		const indexed = new Set(
			Object.values(catalogs).flatMap((catalog) =>
				Object.values(catalog.pages).flatMap((page) => page.sessions.map((session) => session.sessionId)),
			),
		);
		for (const id of Object.keys(local)) if (indexed.has(id)) useLocalSessionsStore.getState().forget(id);
	}, [catalogs, local]);
	const data = useMemo(() => {
		const projects = new Map<string, ProjectEntry>();
		const counts = new Map<string, number>();
		for (const environment of environments)
			for (const summary of catalogs[environmentKey(environment)]?.projects?.projects ?? []) {
				counts.set(summary.cwd, summary.sessionCount);
				if (!isDailyCwd(summary.cwd))
					projects.set(summary.cwd, {
						cwd: summary.cwd,
						name: pathLastSegment(summary.cwd) ?? summary.cwd,
						sessionCount: summary.sessionCount,
						lastActive: summary.lastActive,
						addedIndex: -1,
					});
			}
		for (const session of [...known, ...memory, ...Object.values(local)]) {
			if (
				!pending.current.has(session.sessionId) ||
				session.archivedAt ||
				isDailyCwd(session.cwd) ||
				projects.has(session.cwd)
			)
				continue;
			projects.set(session.cwd, {
				cwd: session.cwd,
				name: pathLastSegment(session.cwd) ?? session.cwd,
				sessionCount: 0,
				lastActive: session.modifiedAt ?? session.createdAt,
				addedIndex: -1,
			});
		}
		for (const [index, cwd] of input.addedProjects.entries()) {
			if (isDailyCwd(cwd)) continue;
			const project = projects.get(cwd);
			projects.set(
				cwd,
				project
					? { ...project, addedIndex: index }
					: { cwd, name: pathLastSegment(cwd) ?? cwd, sessionCount: 0, lastActive: 0, addedIndex: index },
			);
		}
		const sorted = [...projects.values()].sort(
			(a, b) => b.addedIndex - a.addedIndex || b.lastActive - a.lastActive,
		);
		const groups = deriveSidebarGroups({
			sessions: [],
			projects: sorted,
			search: "",
			activeCwd: input.activeCwd,
			pinnedSessions: input.pinnedSessions,
			pinnedProjects: input.pinnedProjects,
			expandedGroups: input.expandedGroups,
			expandedGroupsTouched: input.expandedGroupsTouched,
		});
		const visible = (cwd: string) => {
			if (!search) return true;
			const page =
				catalogs[environmentKey(environmentEntityRef(cwd).environment)]?.pages[
					sessionCatalogPageKey({ cwd, search, archived: false, limit: 6 })
				];
			if (!page || page.loading || page.error || !page.complete) return true;
			const query = search.toLowerCase();
			return [
				...page.sessions,
				...verified,
				...known.filter((s) => !s.sessionFile),
				...memory.filter((s) => !s.sessionFile),
			].some(
				(s) =>
					s.cwd === cwd &&
					!s.archivedAt &&
					((s.name ?? "").toLowerCase().includes(query) || s.sessionId.toLowerCase().includes(query)),
			);
		};
		return {
			...groups,
			dailies: groups.dailies
				.filter((group) => visible(group.cwd))
				.map((group) => ({ ...group, sessionCount: counts.get(group.cwd) ?? 0 })),
			projects: groups.projects
				.filter((group) => visible(group.cwd))
				.map((group) => ({ ...group, sessionCount: counts.get(group.cwd) ?? 0 })),
		};
	}, [
		catalogs,
		environments,
		known,
		memory,
		local,
		search,
		verified,
		input.addedProjects,
		input.activeCwd,
		input.pinnedSessions,
		input.pinnedProjects,
		input.expandedGroups,
		input.expandedGroupsTouched,
	]);
	return {
		data,
		verified: [...verified, ...Object.values(local)],
		catalogs,
		environments,
		dailyDirs: getDailyDirsCached(),
	};
}
