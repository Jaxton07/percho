import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createMcpExtension, type McpRuntimeSnapshot } from "@earendil-works/pi-coding-agent";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
let previousAgentDir: string | undefined;
beforeEach(() => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "mcp-sdk-status-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR);
});
afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

type ExtensionApi = Parameters<ReturnType<typeof createMcpExtension>>[0];
type Handler = (...args: unknown[]) => unknown;
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

describe("MCP SDK status observer", () => {
	it("reports real registered tools, withdrawals, disconnection and reconnect", async () => {
		const events = new Map<string, Handler>();
		const commands = new Map<string, Command>();
		const snapshots: McpRuntimeSnapshot[] = [];
		const registered = new Set<string>();
		let tools = Array.from({ length: 14 }, (_, i) => ({
			name: `tool_${i}`,
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: i === 0 },
		}));
		let peer: ReturnType<typeof createInMemoryTransportPair>["server"];
		let client: ReturnType<typeof createInMemoryTransportPair>["client"];
		let wake: (() => void) | undefined;
		const waitFor = async (predicate: () => boolean) => {
			while (!predicate())
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
		};
		const factory = createMcpExtension({
			loadConfig: () => ({
				servers: ["my-server", "my__server", "x".repeat(100), "empty"].map((name) => ({
					name,
					scope: "global" as const,
					source: "/isolated/mcp.json",
					config: {
						command: "unused",
						env: { TEST_TOKEN: "private-test-token" },
						exposure: "direct" as const,
					},
				})),
				errors: [],
			}),
			createTransport: (entry) => {
				const pair = createInMemoryTransportPair();
				if (entry.name === "my-server") {
					peer = pair.server;
					client = pair.client;
				}
				pair.server.onMessage((message) => {
					if (message.id === undefined) return;
					const result =
						message.method === "initialize"
							? {
									protocolVersion: "2025-03-26",
									capabilities: { tools: { listChanged: true } },
									serverInfo: { name: "test", version: "1" },
								}
							: { tools: entry.name === "empty" ? [] : tools };
					void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
				});
				void pair.server.start();
				return pair.client;
			},
			logPath: join(root, "mcp.log"),
			onStatus: (snapshot) => {
				snapshots.push(snapshot);
				wake?.();
				if (snapshot.servers.some((server) => server.state === "connecting"))
					throw new Error("observer failure");
			},
		});
		factory({
			on: (name: string, handler: Handler) => events.set(name, handler),
			registerToolRenderer() {},
			registerCommand: (name: string, command: Command) => commands.set(name, command),
			getMcpServers: () => [],
			registerTool: (tool: { name: string }) => registered.add(tool.name),
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools() {},
		} as unknown as ExtensionApi);
		const ctx = { cwd: process.cwd(), modelRegistry: {}, ui: { notify() {} } };
		await events.get("session_start")?.({}, ctx);
		await waitFor(() => snapshots.at(-1)?.servers.filter((s) => s.state === "connected").length === 4);
		const snapshot = snapshots.at(-1)!;
		expect(JSON.stringify(snapshots)).not.toContain("private-test-token");
		for (const server of snapshot.servers) {
			expect(server.tools).toHaveLength(server.name === "empty" ? 0 : 14);
			for (const tool of server.tools) expect(registered.has(tool.name)).toBe(true);
		}
		expect(snapshot.servers[0].tools[0].readOnly).toBe(true);
		tools = [];
		await peer!.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await waitFor(() => snapshots.at(-1)?.servers[0].tools.length === 0);
		expect(snapshots.at(-1)!.servers[0].state).toBe("connected");
		let releaseClose!: () => void;
		let closeStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			closeStarted = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const close = client!.close.bind(client);
		client!.close = async () => {
			closeStarted();
			await barrier;
			await close();
		};
		const reconnecting = commands.get("mcp")!.handler("reconnect my-server", ctx);
		await started;
		expect(snapshots.at(-1)?.servers[0].state).toBe("connecting");
		releaseClose();
		await reconnecting;
		expect(snapshots.at(-1)?.servers[0].state).toBe("connected");
		await peer!.close();
		await waitFor(() => snapshots.at(-1)?.servers[0].state === "disconnected");
		await commands.get("mcp")!.handler("reconnect my-server", ctx);
		expect(snapshots.at(-1)!.servers[0]).toMatchObject({ state: "connected", tools: [] });
		expect(snapshots.at(-1)!.servers[0].error).toBeUndefined();
		await events.get("session_shutdown")?.();
		expect(snapshots.at(-1)!.phase).toBe("closed");
	});
	it("reports a thrown configuration load as a structured running failure", async () => {
		const events = new Map<string, Handler>();
		const snapshots: McpRuntimeSnapshot[] = [];
		const failure = new Error("config load failed");
		const factory = createMcpExtension({
			loadConfig: () => {
				throw failure;
			},
			onStatus: (snapshot) => snapshots.push(snapshot),
		});
		factory({
			on: (name: string, handler: Handler) => events.set(name, handler),
			registerToolRenderer() {},
			registerCommand() {},
			getMcpServers: () => [],
		} as unknown as ExtensionApi);
		expect(() =>
			events.get("session_start")?.({}, { cwd: process.cwd(), modelRegistry: {}, ui: { notify() {} } }),
		).toThrow(failure);
		expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(["starting", "running"]);
		expect(snapshots.at(-1)).toMatchObject({ errors: ["config load failed"], servers: [] });
		await events.get("session_shutdown")?.();
		expect(snapshots.at(-1)?.phase).toBe("closed");
	});

	it("reports startup and shutdown even when the observer throws", async () => {
		const events = new Map<string, Handler>();
		const snapshots: McpRuntimeSnapshot[] = [];
		const factory = createMcpExtension({
			loadConfig: () => ({ servers: [], errors: ["bad config"] }),
			onStatus: (snapshot) => {
				snapshots.push(snapshot);
				throw new Error("observer failure");
			},
		});
		factory({
			on: (name: string, handler: Handler) => events.set(name, handler),
			registerToolRenderer() {},
			registerCommand() {},
			getMcpServers: () => [],
		} as unknown as ExtensionApi);
		await events.get("session_start")?.({}, { cwd: process.cwd(), modelRegistry: {}, ui: { notify() {} } });
		expect(snapshots[0].phase).toBe("starting");
		expect(snapshots.at(-1)).toMatchObject({ phase: "running", servers: [], errors: ["bad config"] });
		await events.get("session_shutdown")?.();
		expect(snapshots.at(-1)).toMatchObject({ phase: "closed", servers: [] });
	});
});
