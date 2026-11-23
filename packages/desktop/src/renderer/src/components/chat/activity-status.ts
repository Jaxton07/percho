import type { Translate } from "../../i18n";
import { displayName } from "./tool-label";

export type ActivityStatusKind =
	| "inspect"
	| "edit"
	| "command"
	| "commandWaiting"
	| "web"
	| "subagent"
	| "todo"
	| "toolSearch"
	| "packageSearch"
	| "channelRead"
	| "channelPost"
	| "channelManage"
	| "channelSubscribe"
	| "channelUnsubscribe"
	| "channelList"
	| "thinking"
	| "working"
	| "test"
	| "quality"
	| "build"
	| "install"
	| "changes"
	| "commit"
	| "dev";
export type ActivityStatus = { kind: ActivityStatusKind } | { kind: "legacy"; name: string };

export const STATUS = Object.fromEntries(
	[
		"inspect",
		"edit",
		"command",
		"commandWaiting",
		"web",
		"subagent",
		"todo",
		"toolSearch",
		"packageSearch",
		"channelRead",
		"channelPost",
		"channelManage",
		"channelSubscribe",
		"channelUnsubscribe",
		"channelList",
		"thinking",
		"working",
		"test",
		"quality",
		"build",
		"install",
		"changes",
		"commit",
		"dev",
	].map((kind) => [kind, { kind }]),
) as { [K in ActivityStatusKind]: { kind: K } };

const tools: Record<string, ActivityStatusKind> = {
	read: "inspect",
	ls: "inspect",
	glob: "inspect",
	find: "inspect",
	grep: "inspect",
	edit: "edit",
	write: "edit",
	codemode: "command",
	webfetch: "web",
	subagent: "subagent",
	todo: "todo",
	tool_search: "toolSearch",
	search_pi_packages: "packageSearch",
	channel_read: "channelRead",
	channel_post: "channelPost",
	channel_manage: "channelManage",
	channel_subscribe: "channelSubscribe",
	channel_unsubscribe: "channelUnsubscribe",
	channel_list: "channelList",
};

function classifyCommand(args?: string): ActivityStatus {
	if (!args?.trimEnd().endsWith("}")) return STATUS.command;
	let command: unknown;
	try {
		command = JSON.parse(args)?.command;
	} catch {
		return STATUS.command;
	}
	// Only complete literal words/quotes: never interpret shell expansion or operators.
	if (
		typeof command !== "string" ||
		!/^\s*(?:[\w./@:=+,-]+|"[^"$`\\\n\r]*"|\x27[^\x27\\\n\r]*\x27)(?:\s+(?:[\w./@:=+,-]+|"[^"$`\\\n\r]*"|\x27[^\x27\\\n\r]*\x27))*\s*$/.test(
			command,
		)
	)
		return STATUS.command;
	const words =
		command
			.match(/"[^"]*"|\x27[^\x27]*\x27|[^\s]+/g)
			?.map((word) => (/^["\x27]/.test(word) ? word.slice(1, -1) : word)) ?? [];
	let [program, ...rest] = words;
	if (program === "npx" || program === "bunx") {
		if (rest[0] === "--yes" || rest[0] === "-y") rest.shift();
		[program, ...rest] = rest;
	}
	if (!program) return STATUS.command;
	if (program === "git") {
		if (rest[0] === "status" || rest[0] === "diff") return STATUS.changes;
		if (rest[0] === "commit") return STATUS.commit;
		return STATUS.command;
	}
	if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
		let action = rest[0] ?? "";
		const script = action === "run" || action === "run-script";
		if (script) action = rest[1] ?? "";
		if (action === "test" || action === "t") return STATUS.test;
		if (["lint", "typecheck", "type-check", "format", "check"].includes(action)) return STATUS.quality;
		if (action === "build") return STATUS.build;
		if (!script && ["install", "ci", "add"].includes(action)) return STATUS.install;
		if (action === "dev" || action === "start") return STATUS.dev;
		return STATUS.command;
	}
	if (
		["vitest", "jest", "mocha", "pytest"].includes(program) ||
		(program === "playwright" && rest[0] === "test")
	)
		return STATUS.test;
	if (program === "vite")
		return rest[0] === "build"
			? STATUS.build
			: !rest[0] || rest[0] === "dev" || rest[0] === "serve"
				? STATUS.dev
				: STATUS.command;
	if (program === "biome" || program === "ruff")
		return ["check", "lint", "format"].includes(rest[0] ?? "") ? STATUS.quality : STATUS.command;
	if (program === "tsc" && (rest.includes("--build") || rest.includes("-b"))) return STATUS.build;
	if (["eslint", "prettier", "tsc"].includes(program)) return STATUS.quality;
	return STATUS.command;
}

export function activityStatus(name: string, args?: string): ActivityStatus | null {
	if (name === "show_image" || name === "parallel") return null;
	if (name === "bash") return classifyCommand(args);
	const kind = Object.hasOwn(tools, name) ? tools[name] : undefined;
	return kind ? STATUS[kind] : { kind: "legacy", name };
}

export function translateActivityStatus(status: ActivityStatus, t: Translate): string {
	if (status.kind === "legacy") return displayName(status.name, t);
	if (status.kind === "working") return t("message.working");
	return t(`message.activity.${status.kind}`);
}
