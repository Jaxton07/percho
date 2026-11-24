import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChannelService } from "./service";
import type { ChannelActor } from "./types";

export interface ChannelToolDeps {
	service: (readOnly?: boolean) => Promise<ChannelService>;
	actor: () => ChannelActor;
	authorize?: () => Promise<void>;
	onChanged?: () => void | Promise<void>;
}
const strict = { additionalProperties: false };
const action = Type.Union([
	Type.Literal("create"),
	Type.Literal("subscribe"),
	Type.Literal("unsubscribe"),
	Type.Literal("list"),
]);
const mode = Type.Union([Type.Literal("unread"), Type.Literal("recent"), Type.Literal("start")]);
function checkKeys(value: object, allowed: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		throw new Error("Unknown or invalid parameter");
}
export function makeChannelTools(deps: ChannelToolDeps): ToolDefinition[] {
	const run = async (operation: () => Promise<unknown>) => {
		try {
			await deps.authorize?.();
			const details = await operation();
			try {
				await deps.onChanged?.();
			} catch (error) {
				console.error("Channel snapshot unavailable:", error);
			}
			return {
				content: [{ type: "text" as const, text: JSON.stringify(details ?? null, null, 2) }],
				details,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: message }],
				details: { error: message },
				isError: true,
			};
		}
	};
	return [
		defineTool({
			name: "channel_manage",
			annotations: { readOnlyHint: false, destructiveHint: false },
			promptSnippet: "channel_manage({action, topic}) — manage channel membership",
			label: "Manage channels",
			description: "Create, subscribe, unsubscribe or list project channels.",
			parameters: Type.Object(
				{
					action,
					topic: Type.Optional(Type.String()),
					scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("subscribed")])),
					limit: Type.Optional(Type.Integer()),
					cursor: Type.Optional(Type.String()),
				},
				strict,
			),
			async execute(_id, params) {
				return run(async () => {
					checkKeys(params, ["action", "topic", "scope", "limit", "cursor"]);
					return (await deps.service(params.action === "list")).manage(deps.actor(), params);
				});
			},
		}),
		defineTool({
			name: "channel_post",
			annotations: { readOnlyHint: false, destructiveHint: false },
			promptSnippet: "channel_post({topic, message}) — post a channel message",
			label: "Post channel message",
			description: "Post a message to a subscribed channel without waking other sessions.",
			parameters: Type.Object({ topic: Type.String(), message: Type.String() }, strict),
			async execute(id, params) {
				return run(async () => {
					checkKeys(params, ["topic", "message"]);
					return (await deps.service()).post(deps.actor(), params.topic, params.message, id);
				});
			},
		}),
		defineTool({
			name: "channel_read",
			annotations: { readOnlyHint: false, destructiveHint: false },
			promptSnippet: "channel_read({topic}) — read channel messages",
			label: "Read channel messages",
			description: "Read unread or historical channel messages.",
			parameters: Type.Object(
				{
					topic: Type.String(),
					mode: Type.Optional(mode),
					cursor: Type.Optional(Type.String()),
					limit: Type.Optional(Type.Integer()),
				},
				strict,
			),
			async execute(id, params) {
				return run(async () => {
					checkKeys(params, ["topic", "mode", "cursor", "limit"]);
					// Resolve without unrelated maintenance; unread acknowledgement owns its own transaction.
					return (await deps.service(true)).read(deps.actor(), params, id);
				});
			},
		}),
	];
}
