import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

const agentDir = vi.hoisted(() => ({ value: "" }));
const observers = vi.hoisted(() => ({
	callbacks: [] as Array<(snapshot: import("@earendil-works/pi-coding-agent").McpRuntimeSnapshot) => void>,
	snapshots: [] as import("@earendil-works/pi-coding-agent").McpRuntimeSnapshot[],
}));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
	const sdk = await original<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...sdk,
		getAgentDir: () => agentDir.value,
		createMcpExtension: (options: Parameters<typeof sdk.createMcpExtension>[0]) => {
			const onStatus = options?.onStatus;
			if (!onStatus) return sdk.createMcpExtension(options);
			observers.callbacks.push(onStatus);
			return sdk.createMcpExtension({
				...options,
				onStatus: (snapshot) => {
					observers.snapshots.push(snapshot);
					onStatus(snapshot);
				},
			});
		},
	};
});
const { PiBackend } = await import("../src/pi-backend");

async function reloadSdkResources(backend: InstanceType<typeof PiBackend>, sessionId: string) {
	const registry = (backend as unknown as { registry: import("../src/session/registry").SessionRegistry })
		.registry;
	const entry = registry.get(sessionId);
	if (!entry) throw new Error("Missing SDK session");
	await entry.session.reload();
}

it("does not inherit defaultCwd for MCP requests and rejects stale login instances", async () => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-no-default-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	mkdirSync(join(root, ".pi"));
	writeFileSync(
		join(root, ".pi", "mcp.json"),
		JSON.stringify({ mcpServers: { project: { command: "node" } } }),
	);
	const backend = new PiBackend({ defaultCwd: root, projectTrust: false, permissionGates: false });
	try {
		const result = await backend.getMcpConfig();
		expect(result.contextCwd).toBeUndefined();
		expect(result.project).toEqual([]);
		expect(result.selectedInstanceId).toBeUndefined();
		await expect(backend.upsertMcpServer({ scope: "project", name: "x", command: "node" })).rejects.toThrow();
		await expect(backend.removeMcpServer({ scope: "project", name: "project" })).rejects.toThrow();
		await expect(backend.mcpLogin({ instanceId: "stale", name: "project" })).rejects.toThrow();
	} finally {
		await backend.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

it("explains valid project overrides before any runtime has started", async () => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-unstarted-override-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	mkdirSync(join(root, ".pi"));
	writeFileSync(
		join(agentDir.value, "mcp.json"),
		JSON.stringify({ mcpServers: { demo: { command: "node" } } }),
	);
	writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { demo: { enabled: true } } }));
	new ProjectTrustStore(agentDir.value).set(root, true);
	const backend = new PiBackend({ permissionGates: false });
	try {
		const result = await backend.getMcpConfig({ cwd: root });
		expect(result.errors).toEqual([]);
		expect(result.runtime?.instances).toEqual([]);
		expect(result.global[0]?.state).toBe("overridden");
		expect(result.project[0]?.state).toBe("not-started");
	} finally {
		await backend.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

it("returns a revisioned empty inventory without starting a session", async () => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-runtime-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	try {
		const result = await backend.getMcpConfig({ cwd: root });
		expect(result.contextCwd).toBe(root);
		expect(result.runtime).toMatchObject({ revision: 0, instances: [] });
		expect(result.runtime?.epoch).toBeTruthy();
	} finally {
		await backend.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

it("exposes real SDK status and revokes the instance on close", async () => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-sdk-backend-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir.value;
	const server = join(root, "server.mjs");
	writeFileSync(
		server,
		`import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{tools:[{name:'one',inputSchema:{type:'object'}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
	);
	writeFileSync(
		join(agentDir.value, "mcp.json"),
		JSON.stringify({
			mcpServers: { "my-server": { command: process.execPath, args: [server], exposure: "direct" } },
		}),
	);
	const backend = new PiBackend({ defaultCwd: root, projectTrust: false, permissionGates: false });
	const events: import("@percho/shared").McpRuntimeInventory[] = [];
	backend.onMcpServersChanged((event) => events.push(event));
	observers.callbacks.length = 0;
	observers.snapshots.length = 0;
	try {
		const session = await backend.createSession({ cwd: root });
		await vi.waitFor(
			async () => {
				const result = await backend.getMcpConfig({ cwd: root });
				expect(result.global[0]).toMatchObject({
					name: "my-server",
					state: "connected",
					tools: [{ name: expect.any(String) }],
				});
			},
			{ timeout: 10000 },
		);
		const before = await backend.getMcpConfig({ cwd: root });
		const withoutCwd = await backend.getMcpConfig();
		expect(withoutCwd.contextCwd).toBeUndefined();
		expect(withoutCwd.selectedInstanceId).toBeUndefined();
		const oldObserver = observers.callbacks[0];
		const oldSnapshot = observers.snapshots.findLast((snapshot) =>
			snapshot.servers.some((server) => server.state === "connected"),
		);
		expect(oldObserver).toBeDefined();
		expect(oldSnapshot).toBeDefined();
		expect(before.selectedInstanceId).toBeTruthy();
		expect(events.at(-1)?.revision).toBe(before.runtime?.revision);
		const otherCwd = join(root, "other");
		mkdirSync(otherCwd);
		const other = await backend.createSession({ cwd: otherCwd });
		const isolated = await backend.getMcpConfig({ cwd: otherCwd, instanceId: before.selectedInstanceId });
		expect(isolated.selectedInstanceId).toBeUndefined();
		expect(isolated.global[0]?.state).toBe("unknown");
		await backend.closeSession(other.sessionId);
		await reloadSdkResources(backend, session.sessionId);
		await vi.waitFor(
			async () => {
				const reloaded = await backend.getMcpConfig({ cwd: root });
				expect(reloaded.selectedInstanceId).not.toBe(before.selectedInstanceId);
				expect(reloaded.global[0]?.state).toBe("connected");
			},
			{ timeout: 10000 },
		);
		const reloaded = await backend.getMcpConfig({ cwd: root });
		await expect(
			backend.mcpLogin({ instanceId: before.selectedInstanceId ?? "missing", name: "my-server" }),
		).rejects.toThrow();
		oldObserver!(oldSnapshot!);
		expect((await backend.getMcpConfig({ cwd: root })).runtime).toEqual(reloaded.runtime);
		await backend.closeSession(session.sessionId);
		oldObserver!(oldSnapshot!);
		const after = await backend.getMcpConfig({ cwd: root });
		expect(after.runtime?.instances).toEqual([]);
		expect(after.global[0]?.state).toBe("not-started");
		expect(after.runtime?.revision ?? 0).toBeGreaterThan(before.runtime?.revision ?? 0);
	} finally {
		await backend.shutdown();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

it("does not dispatch reconnect while the real SDK connection is still starting", async () => {
	const base = resolve("../../.local/tmp/reconnect-native");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "connecting-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir.value;
	const server = join(root, "pending.mjs");
	writeFileSync(server, "process.stdin.resume();\n");
	writeFileSync(
		join(agentDir.value, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				pending: { command: process.execPath, args: [server] },
			},
		}),
	);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	try {
		const meta = await backend.createSession({ cwd: root });
		const instance = (await backend.getMcpConfig({ cwd: root })).runtime?.instances[0];
		const registry = (backend as unknown as { registry: import("../src/session/registry").SessionRegistry })
			.registry;
		const entry = registry.get(meta.sessionId);
		if (!instance || !entry) throw new Error("Missing connecting fixture");
		expect(instance.servers[0]?.state).toBe("connecting");
		const prompt = vi.spyOn(entry.session, "prompt");
		await expect(
			backend.reconnectMcpServer({ instanceId: instance.instanceId, name: "pending" }),
		).rejects.toThrow("无法重连");
		expect(prompt).not.toHaveBeenCalled();
	} finally {
		await backend.shutdown();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

it("reconnects only the selected real SDK server without reloading or aborting sessions", async () => {
	const base = resolve("../../.local/tmp/reconnect-native");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "sdk-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir.value;
	const server = join(root, "server.mjs");
	const counts = join(root, "connections");
	writeFileSync(counts, "");
	writeFileSync(
		server,
		`import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
let closed=false;
const recordClose=()=>{if(!closed){closed=true;appendFileSync(process.argv[2],process.argv[3]+':closed'+String.fromCharCode(10))}};
process.on('exit',recordClose);
process.on('SIGTERM',()=>{recordClose();process.exit(0)});
appendFileSync(process.argv[2], process.argv[3]+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{tools:[]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
	);
	writeFileSync(
		join(agentDir.value, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				alpha: { command: process.execPath, args: [server, counts, "alpha"] },
				beta: { command: process.execPath, args: [server, counts, "beta"] },
				disabled: { command: process.execPath, args: [server, counts, "disabled"], enabled: false },
			},
		}),
	);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	try {
		const first = await backend.createSession({ cwd: root });
		const second = await backend.createSession({ cwd: root });
		await vi.waitFor(
			async () => {
				const instances = (await backend.getMcpConfig({ cwd: root })).runtime?.instances ?? [];
				expect(instances).toHaveLength(2);
				expect(
					instances.every((instance) => instance.servers.filter((s) => s.state === "connected").length === 2),
				).toBe(true);
			},
			{ timeout: 10000 },
		);
		const inventory = (await backend.getMcpConfig({ cwd: root })).runtime;
		const instance = inventory?.instances.find((item) => item.sessionId === first.sessionId);
		const registry = (backend as unknown as { registry: import("../src/session/registry").SessionRegistry })
			.registry;
		const firstEntry = registry.get(first.sessionId);
		const secondEntry = registry.get(second.sessionId);
		if (!inventory || !instance || !firstEntry || !secondEntry) throw new Error("Missing runtime fixture");
		const entries = [firstEntry, secondEntry];
		const reloads = entries.map((entry) => vi.spyOn(entry.session, "reload"));
		const aborts = entries.map((entry) => vi.spyOn(entry.session, "abort"));
		const beforeMessages = entries.map((entry) => entry.session.messages.length);
		const saved = await backend.upsertMcpServer({ scope: "user", name: "alpha", command: "missing-command" });
		expect(saved.config.restartRequired).toBe(true);
		expect(readFileSync(counts, "utf8").trim().split("\n")).toHaveLength(4);
		await expect(backend.reconnectMcpServer({ instanceId: "stale", name: "alpha" })).rejects.toThrow();
		await expect(
			backend.reconnectMcpServer({ instanceId: instance.instanceId, name: "absent" }),
		).rejects.toThrow();
		await expect(
			backend.reconnectMcpServer({ instanceId: instance.instanceId, name: "disabled" }),
		).rejects.toThrow();
		const command = vi.spyOn(firstEntry.session.extensionRunner, "getCommand").mockReturnValueOnce(undefined);
		await expect(
			backend.reconnectMcpServer({ instanceId: instance.instanceId, name: "alpha" }),
		).rejects.toThrow();
		command.mockRestore();
		await backend.reconnectMcpServer({ instanceId: instance.instanceId, name: "alpha" });
		expect((await backend.getMcpConfig()).restartRequired).toBe(true);
		const lines = readFileSync(counts, "utf8").trim().split("\n");
		expect(lines.filter((line) => line === "alpha")).toHaveLength(3);
		expect(lines.filter((line) => line === "beta")).toHaveLength(2);
		expect(lines.filter((line) => line === "alpha:closed")).toHaveLength(1);
		expect(lines.filter((line) => line === "beta:closed")).toHaveLength(0);
		expect(
			(await backend.getMcpConfig({ cwd: root })).runtime?.instances.every((item) =>
				item.servers
					.filter((server) => server.name !== "disabled")
					.every((server) => server.state === "connected"),
			),
		).toBe(true);
		expect(
			(await backend.getMcpConfig({ cwd: root })).runtime?.instances.map((item) => item.instanceId),
		).toEqual(inventory.instances.map((item) => item.instanceId));
		expect(entries.map((entry) => entry.session.messages.length)).toEqual(beforeMessages);
		for (const spy of [...reloads, ...aborts]) expect(spy).not.toHaveBeenCalled();
		const session = entries[0].session;
		const model: Model<"openai-completions"> = {
			id: "fixture",
			name: "fixture",
			provider: "fixture",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			input: ["text"],
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		session.agent.state.model = model;
		const runtime = (session as unknown as { _modelRuntime: { checkAuth: () => Promise<unknown> } })
			._modelRuntime;
		vi.spyOn(runtime, "checkAuth").mockResolvedValue({ type: "api_key", key: "fixture" });
		const stream = createAssistantMessageEventStream();
		const requests = vi.fn(async () => stream);
		session.agent.streamFunction = requests;
		const run = session.prompt("hold a real generation open");
		try {
			await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
			expect(session.isStreaming).toBe(true);
			const untouchedConnections = readFileSync(counts, "utf8");
			await backend.upsertMcpServer({
				scope: "user",
				cwd: root,
				name: "alpha",
				description: "saved during real generation",
			});
			expect(readFileSync(counts, "utf8")).toBe(untouchedConnections);
			expect(session.isStreaming).toBe(true);
			const messages = session.messages.length;
			await backend.reconnectMcpServer({ instanceId: instance.instanceId, name: "alpha" });
			expect(requests).toHaveBeenCalledTimes(1);
			expect(session.messages.length).toBe(messages);
			expect(session.isStreaming).toBe(true);
			const afterStreamingReconnect = readFileSync(counts, "utf8").trim().split("\n");
			expect(afterStreamingReconnect.filter((line) => line === "alpha:closed")).toHaveLength(2);
			expect(afterStreamingReconnect.filter((line) => line === "beta:closed")).toHaveLength(0);
			for (const spy of [...reloads, ...aborts]) expect(spy).not.toHaveBeenCalled();
		} finally {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					stopReason: "stop",
					content: [{ type: "text", text: "done" }],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			});
			await run;
		}
		// Closing the selected instance while the command is outstanding must not report success.
		vi.spyOn(firstEntry.session, "prompt").mockImplementationOnce(async () => {
			await backend.closeSession(first.sessionId);
		});
		await expect(
			backend.reconnectMcpServer({ instanceId: instance.instanceId, name: "alpha" }),
		).rejects.toThrow("失效");
		expect(
			(await backend.getMcpConfig({ cwd: root })).runtime?.instances.map((item) => item.sessionId),
		).toEqual([second.sessionId]);
	} finally {
		await backend.shutdown();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

it("rejects untrusted and missing project directories before removing anything", async () => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-remove-trust-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	mkdirSync(join(root, ".pi"));
	const global = join(agentDir.value, "mcp.json");
	const project = join(root, ".pi", "mcp.json");
	const contents = JSON.stringify({ mcpServers: { demo: { command: "node" } } });
	writeFileSync(global, contents);
	writeFileSync(project, contents);
	new ProjectTrustStore(agentDir.value).set(root, false);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	try {
		await expect(backend.removeMcpServer({ scope: "project", cwd: root, name: "demo" })).rejects.toThrow();
		await expect(backend.removeMcpServer({ scope: "project", name: "demo" })).rejects.toThrow();
		expect(readFileSync(global, "utf8")).toBe(contents);
		expect(readFileSync(project, "utf8")).toBe(contents);
	} finally {
		await backend.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

it.each(["partial", "replacement"] as const)(
	"attributes a project %s only to its effective source",
	async (kind) => {
		const base = resolve("../../.local/tmp");
		mkdirSync(base, { recursive: true });
		const root = mkdtempSync(join(base, "mcp-override-"));
		agentDir.value = join(root, "agent");
		mkdirSync(agentDir.value);
		mkdirSync(join(root, ".pi"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir.value;
		const server = join(root, "server.mjs");
		writeFileSync(
			server,
			`import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{tools:[{name:'project_tool',inputSchema:{type:'object'}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
		);
		writeFileSync(
			join(agentDir.value, "mcp.json"),
			JSON.stringify({
				mcpServers: { demo: { command: process.execPath, args: [server], exposure: "direct" } },
			}),
		);
		writeFileSync(
			join(root, ".pi", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo:
						kind === "partial"
							? { exposure: "direct" }
							: { command: process.execPath, args: [server], exposure: "direct" },
				},
			}),
		);
		new ProjectTrustStore(agentDir.value).set(root, true);
		const backend = new PiBackend({ projectTrust: false, permissionGates: false });
		const events: import("@percho/shared").McpRuntimeInventory[] = [];
		backend.onMcpServersChanged((event) => events.push(event));
		try {
			await backend.createSession({ cwd: root });
			await vi.waitFor(
				async () => {
					const result = await backend.getMcpConfig({ cwd: root });
					expect(events.at(-1)?.instances[0]?.servers).toHaveLength(1);
					expect(result.project[0]).toMatchObject({
						state: "connected",
						tools: [{ name: expect.any(String) }],
					});
					expect(events.at(-1)?.instances[0]?.servers[0]).toMatchObject(
						kind === "partial"
							? { source: result.globalPath, override: result.projectPath }
							: { source: result.projectPath },
					);
					expect(result.global[0]).toMatchObject({ tools: [], state: "overridden" });
				},
				{ timeout: 10000 },
			);
		} finally {
			await backend.shutdown();
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		}
	},
	15000,
);

it("reports unknown connections but preserves valid overrides when a third-party extension replaces MCP", async () => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-replacement-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir.value;
	writeFileSync(
		join(root, ".pi", "extensions", "replacement.ts"),
		`export default function(pi) { pi.registerCommand('mcp', {description:'replacement', handler: async () => {}}); }`,
	);
	writeFileSync(
		join(agentDir.value, "mcp.json"),
		JSON.stringify({ mcpServers: { demo: { command: "missing-command" } } }),
	);
	writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { demo: { enabled: true } } }));
	new ProjectTrustStore(agentDir.value).set(root, true);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const events: import("@percho/shared").McpRuntimeInventory[] = [];
	backend.onMcpServersChanged((event) => events.push(event));
	try {
		await backend.createSession({ cwd: root });
		const result = await backend.getMcpConfig({ cwd: root });
		expect(result.errors).toEqual([]);
		expect(result.global[0]).toMatchObject({ state: "overridden", tools: [] });
		expect(result.project[0]).toMatchObject({ state: "unknown", tools: [] });
		expect(result.runtime?.instances[0]).toMatchObject({ available: false, servers: [] });
		await expect(
			backend.reconnectMcpServer({
				instanceId: result.runtime?.instances[0]?.instanceId ?? "missing",
				name: "demo",
			}),
		).rejects.toThrow();
		expect(events.at(-1)?.revision).toBe(result.runtime?.revision);
	} finally {
		await backend.shutdown();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

it("prefers real SDK enable and disable status over stale configuration", async () => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-live-enabled-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	mkdirSync(join(root, ".pi"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir.value;
	const server = join(root, "server.mjs");
	writeFileSync(
		server,
		`import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{tools:[]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
	);
	const configPath = join(agentDir.value, "mcp.json");
	const save = (enabled: boolean) =>
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: { demo: { command: process.execPath, args: [server], enabled } },
			}),
		);
	save(false);
	new ProjectTrustStore(agentDir.value).set(root, true);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	try {
		const session = await backend.createSession({ cwd: root });
		save(true);
		await reloadSdkResources(backend, session.sessionId);
		await vi.waitFor(
			async () => {
				expect((await backend.getMcpConfig({ cwd: root })).runtime?.instances[0]?.servers[0]?.state).toBe(
					"connected",
				);
			},
			{ timeout: 10000 },
		);
		save(false);
		let result = await backend.getMcpConfig({ cwd: root });
		expect(result.global[0]).toMatchObject({ state: "connected", enabled: true, tools: [] });
		// New project config must not be mistaken for the source of an existing global connection.
		writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { demo: { enabled: true } } }));
		result = await backend.getMcpConfig({ cwd: root });
		expect(result.global[0]).toMatchObject({ state: "connected", enabled: true });
		expect(result.project[0]?.state).toBe("unknown");
		rmSync(join(root, ".pi", "mcp.json"));
		save(false);
		await reloadSdkResources(backend, session.sessionId);
		await vi.waitFor(
			async () => {
				expect((await backend.getMcpConfig({ cwd: root })).runtime?.instances[0]?.servers[0]?.state).toBe(
					"disabled",
				);
			},
			{ timeout: 10000 },
		);
		save(true);
		result = await backend.getMcpConfig({ cwd: root });
		expect(result.global[0]).toMatchObject({ state: "disabled", enabled: false, tools: [] });
	} finally {
		await backend.shutdown();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

it("publishes real tool withdrawal and clears a connection failure on reload", async () => {
	const base = resolve("../../.local/tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-withdraw-"));
	agentDir.value = join(root, "agent");
	mkdirSync(agentDir.value);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir.value;
	const server = join(root, "server.mjs");
	const control = join(root, "control");
	writeFileSync(control, "one");
	writeFileSync(
		server,
		`import readline from 'node:readline';
import {readFileSync, watch} from 'node:fs';
const control=process.argv[2];
watch(control, () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\\n'));
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'test',version:'1'}}:{tools:readFileSync(control,'utf8')==='one'?[{name:'one',inputSchema:{type:'object'}}]:[]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`,
	);
	const configPath = join(agentDir.value, "mcp.json");
	const save = (command: string, args: string[]) =>
		writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: { demo: { command, args, exposure: "direct" } },
			}),
		);
	save(join(root, "missing-command"), []);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	const events: import("@percho/shared").McpRuntimeInventory[] = [];
	backend.onMcpServersChanged((event) => events.push(event));
	try {
		const session = await backend.createSession({ cwd: root });
		await vi.waitFor(
			async () => {
				const view = (await backend.getMcpConfig({ cwd: root })).global[0];
				expect(view?.state).toBe("failed");
				expect(view?.error).toBeTruthy();
			},
			{ timeout: 10000 },
		);
		save(process.execPath, [server, control]);
		await reloadSdkResources(backend, session.sessionId);
		await vi.waitFor(
			async () => {
				const view = (await backend.getMcpConfig({ cwd: root })).global[0];
				expect(view).toMatchObject({ state: "connected", tools: [{ name: expect.any(String) }] });
				expect(view?.error).toBeUndefined();
			},
			{ timeout: 10000 },
		);
		writeFileSync(control, "none");
		await vi.waitFor(
			async () => {
				const result = await backend.getMcpConfig({ cwd: root });
				expect(result.global[0]).toMatchObject({ state: "connected", tools: [] });
				expect(events.at(-1)?.instances[0]?.servers[0]).toMatchObject({ state: "connected", tools: [] });
				expect(events.at(-1)?.revision).toBe(result.runtime?.revision);
			},
			{ timeout: 10000 },
		);
	} finally {
		await backend.shutdown();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
