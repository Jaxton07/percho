import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { makeChannelsExtension } from "../src/tools/channels/extension";
import type { ChannelService } from "../src/tools/channels/service";

test("unread projection is ephemeral, fails softly and never wakes sessions", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools: string[] = [];
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerTool: (tool: { name: string }) => tools.push(tool.name),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "s", getSessionName: () => "name" },
	} as unknown as ExtensionContext;
	let unread = 2;
	const service = { snapshot: async () => [{ topic: "work", unread }] } as unknown as ChannelService;
	const extension = makeChannelsExtension({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		service: async () => service,
		isEnabled: () => true,
		authorizeRoot: async () => true,
	});
	await extension.factory(pi);
	await handlers.get("session_start")!({}, ctx);
	const event = { messages: [{ role: "system", content: "system" }] };
	const result = await handlers.get("context_with_system")!(event, ctx);
	expect(tools).toEqual(["channel_manage", "channel_post", "channel_read"]);
	expect(result.messages[1]).toMatchObject({ role: "custom", display: false, customType: "channels-unread" });
	expect(event.messages).toHaveLength(1);
	expect(result.messages[1].content).toContain("可自行决定是否读取");
	unread = 0;
	expect(await handlers.get("context_with_system")!(event, ctx)).toBeUndefined();
	await handlers.get("session_shutdown")!({}, ctx);
	expect(await handlers.get("context_with_system")!(event, ctx)).toBeUndefined();
});

test("disabled at load exposes no tools and remains disabled until reload", async () => {
	let enabled = false;
	const tools: string[] = [];
	const pi = {
		on: () => {},
		registerTool: (tool: { name: string }) => tools.push(tool.name),
	} as unknown as ExtensionAPI;
	const extension = makeChannelsExtension({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		isEnabled: () => enabled,
	});
	await extension.factory(pi);
	enabled = true;
	expect(tools).toEqual([]);
});

test("cleanup does not report an empty subscription snapshot", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const reports: unknown[] = [];
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerTool: () => {},
	} as unknown as ExtensionAPI;
	const ctx = { sessionManager: { getSessionId: () => "s" } } as unknown as ExtensionContext;
	const extension = makeChannelsExtension({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		isEnabled: () => true,
		authorizeRoot: async () => true,
		service: async () => ({ snapshot: async () => [{ topic: "x", unread: 1 }] }) as unknown as ChannelService,
		onSnapshot: (_id, entries) => reports.push(entries),
	});
	await extension.factory(pi);
	await handlers.get("session_start")!({}, ctx);
	await handlers.get("session_shutdown")!({}, ctx);
	expect(reports).toEqual([[{ topic: "x", unread: 1 }]]);
});
