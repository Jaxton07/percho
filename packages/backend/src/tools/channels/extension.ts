import { realpath } from "node:fs/promises";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { readChannelWatchEnabled } from "../channel-watch/config";
import { resolveChannelProject } from "./project";
import { ChannelService } from "./service";
import { makeChannelTools } from "./tools";
import type { ChannelSnapshotEntry } from "./types";

export interface ChannelsExtensionOptions {
	agentDir: string;
	cwd: string;
	projectRoot?: string;
	service?: (readOnly?: boolean) => Promise<ChannelService>;
	isEnabled?: () => boolean;
	authorizeRoot?: (root: string, ctx: ExtensionContext) => Promise<boolean>;
	onSnapshot?: (sessionId: string, entries: ChannelSnapshotEntry[]) => void;
	onSessionCleanup?: (cleanup: () => void) => void;
	isSessionAlive?: (sessionId: string) => boolean;
}
export function makeChannelsExtension(options: ChannelsExtensionOptions): InlineExtension {
	return {
		name: "channels",
		factory: (pi) => {
			let context: ExtensionContext | undefined;
			let sessionId: string | undefined;
			let generation = 0;
			let ownService: Promise<ChannelService> | undefined;
			const enabled = (options.isEnabled ?? (() => readChannelWatchEnabled(options.agentDir)))();
			if (!enabled) return;
			const live = () => !!context && !!sessionId && (options.isSessionAlive?.(sessionId) ?? true);
			let resolvedRoot: Promise<string> | undefined;
			const root = () => {
				resolvedRoot ??= resolveChannelProject(options.cwd, options.projectRoot).catch((error) => {
					resolvedRoot = undefined;
					throw error;
				});
				return resolvedRoot;
			};
			const authorize = async () => {
				const ctx = context;
				if (!ctx || !live()) throw new Error("Channels unavailable for this session");
				const resolved = await root();
				const trusted = options.authorizeRoot
					? await options.authorizeRoot(resolved, ctx)
					: ctx.isProjectTrusted() && resolved === (await realpath(ctx.cwd));
				if (!trusted || ctx !== context || !live()) throw new Error("Channel project is not trusted");
			};
			const service = (readOnly = false) => {
				if (options.service) return options.service(readOnly);
				ownService ??= root().then(
					(projectRoot) => new ChannelService({ projectRoot, agentDir: options.agentDir }),
				);
				return ownService;
			};
			const actor = () => {
				if (!context || !live()) throw new Error("Channels unavailable for this session");
				return {
					sessionId: context.sessionManager.getSessionId(),
					sessionName: context.sessionManager.getSessionName(),
				};
			};
			const report = async () => {
				const id = sessionId,
					epoch = generation;
				if (!id || !live()) return;
				await authorize();
				const entries = await (await service(true)).snapshot(id);
				if (generation === epoch && live()) options.onSnapshot?.(id, entries);
			};
			for (const tool of makeChannelTools({ service, actor, authorize, onChanged: report }))
				pi.registerTool(tool);
			const cleanup = () => {
				generation++;
				context = undefined;
				sessionId = undefined;
				const owned = ownService;
				ownService = undefined;
				if (owned)
					void owned
						.then((s) => s.close())
						.catch((error) => console.error("Channel service close failed:", error));
			};
			options.onSessionCleanup?.(cleanup);
			pi.on("session_start", async (_event, ctx) => {
				context = ctx;
				sessionId = ctx.sessionManager.getSessionId();
				generation++;
				try {
					await report();
				} catch (error) {
					console.error("Channel snapshot unavailable:", error);
				}
			});
			pi.on("session_shutdown", async () => {
				cleanup();
			});
			pi.on("context_with_system", async (event, ctx) => {
				try {
					if (!live() || !sessionId || ctx.sessionManager.getSessionId() !== sessionId) return;
					const id = sessionId,
						epoch = generation;
					await authorize();
					const entries = await (await service(true)).snapshot(id);
					if (epoch !== generation || !live()) return;
					options.onSnapshot?.(id, entries);
					const unread = entries.filter((entry) => entry.unread > 0);
					if (!unread.length) return;
					return {
						messages: [
							...event.messages,
							{
								role: "custom" as const,
								customType: "channels-unread",
								content: `未读频道消息：${JSON.stringify(unread)}。可自行决定是否读取（channel_read）。`,
								display: false,
								timestamp: Date.now(),
							},
						],
					};
				} catch (error) {
					console.error("Channel summary unavailable:", error);
				}
			});
		},
	};
}
