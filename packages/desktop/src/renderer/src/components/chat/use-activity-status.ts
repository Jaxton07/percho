import type { MetaItem, UIToolCall } from "@percho/shared";
import { useEffect, useMemo, useReducer } from "react";
import { activityStatus, STATUS } from "./activity-status";

export interface ActiveSubagent {
	id: string;
	blockIndex?: number;
}

/** Read the current group's activity, never reconstruct or summarize growing output. */
export function useActivityStatus(items: MetaItem[], working: boolean, activeSubagent?: ActiveSubagent) {
	const [, tick] = useReducer((n: number) => n + 1, 0);
	let tool: UIToolCall | undefined;
	let name: string | undefined;
	let source: string | undefined;
	let blockIndex: number | undefined;
	let latestThinking: string | undefined;
	let foundLatest = false;
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (!item) continue;
		for (let j = (item.activity?.length ?? 0) - 1; j >= 0; j--) {
			const entry = item.activity?.[j];
			if (!entry) continue;
			if (!foundLatest) {
				foundLatest = true;
				if (entry.kind === "thinking") latestThinking = `${item.sourceId ?? i}:${entry.id}`;
			}
			if (entry.kind !== "tool" || entry.name === "show_image" || entry.name === "parallel") continue;
			name = entry.name;
			source = item.sourceId;
			tool = item.tools.findLast((candidate) =>
				candidate.blockIndex !== undefined
					? entry.id === `c${candidate.blockIndex}`
					: candidate.name === entry.name,
			);
			blockIndex = tool?.blockIndex;
			break;
		}
		if (name) break;
	}
	// Non-preview callers and older history have no activity entries.
	if (!foundLatest) {
		for (let i = items.length - 1; i >= 0 && !tool; i--) {
			tool = items[i]?.tools.findLast(
				(candidate) => candidate.name !== "show_image" && candidate.name !== "parallel",
			);
			if (tool) {
				name = tool.name;
				source = items[i]?.sourceId;
				blockIndex = tool.blockIndex;
			}
		}
	}
	const args = tool?.id ? tool.args : undefined;
	const mapped = useMemo(() => (name ? activityStatus(name, args) : undefined), [name, args]);
	const subagentIsLatest = Boolean(
		activeSubagent &&
			(!name ||
				source !== items.at(-1)?.sourceId ||
				blockIndex === undefined ||
				activeSubagent.blockIndex === undefined ||
				activeSubagent.blockIndex >= blockIndex),
	);
	const startedAt =
		!subagentIsLatest && mapped?.kind === "command" && tool?.state === "running" && tool.endedAt === undefined
			? tool.startedAt
			: undefined;
	useEffect(() => {
		if (!working || startedAt === undefined) return;
		const remaining = startedAt + 10_001 - Date.now();
		if (remaining <= 0) return;
		const timer = window.setTimeout(tick, Math.min(remaining, 2_147_483_647));
		return () => window.clearTimeout(timer);
	}, [working, startedAt]);
	return {
		status: subagentIsLatest
			? STATUS.subagent
			: startedAt !== undefined && Date.now() - startedAt > 10_000
				? STATUS.commandWaiting
				: (mapped ?? (latestThinking ? STATUS.thinking : STATUS.working)),
		thinkingId: latestThinking,
		hasRunningTool:
			Boolean(activeSubagent) ||
			items.some((item) => item.tools.some((candidate) => candidate.state === "running")),
	};
}
