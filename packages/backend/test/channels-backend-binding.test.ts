import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { ChannelBackendHost } from "../src/tools/channels/backend-host";
import type { ChannelService } from "../src/tools/channels/service";

it("preserves legacy projects and unknown data when binding across host restarts", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-bind-"));
	try {
		const file = join(root, "channel-projects.json");
		writeFileSync(file, JSON.stringify([root]));
		const host = () =>
			new ChannelBackendHost(root, () => {
				throw new Error("unexpected service");
			});
		await host().bind("session", root, root);
		expect(await host().binding("session")).toEqual({ root, cwd: root });
		const data = JSON.parse(readFileSync(file, "utf8"));
		data.future = { value: 1 };
		writeFileSync(file, JSON.stringify(data));
		await host().bind("other", root, root);
		expect(JSON.parse(readFileSync(file, "utf8")).future).toEqual({ value: 1 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("serializes concurrent registrations from independent workers and rejects conflicting bindings", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-workers-"));
	const agent = join(root, "agent");
	const source = fileURLToPath(new URL("../src/tools/channels/backend-host.ts", import.meta.url));
	const script = `
		const { parentPort, workerData } = require('node:worker_threads');
		const ts = require('typescript');
		const fs = require('node:fs');
		require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
		const { ChannelBackendHost } = require(workerData.source);
		parentPort.once('message', async () => {
			try { await new ChannelBackendHost(workerData.agent, () => {}).bind(workerData.id, workerData.root, workerData.root); parentPort.postMessage('done'); }
			catch (e) { parentPort.postMessage({ error: String(e) }); }
		});
	`;
	try {
		const roots = [join(root, "one"), join(root, "two")];
		const workers = roots.map(
			(project, index) =>
				new Worker(script, { eval: true, workerData: { source, agent, root: project, id: `s${index}` } }),
		);
		const results = workers.map(
			(worker) =>
				new Promise<void>((resolve, reject) => {
					worker.once("error", reject);
					worker.once("message", (result) =>
						result === "done" ? resolve() : reject(new Error(JSON.stringify(result))),
					);
				}),
		);
		for (const worker of workers) worker.postMessage("go");
		await Promise.all(results);
		const restarted = new ChannelBackendHost(agent, () => {
			throw new Error("unexpected service");
		});
		expect(await restarted.binding("s0")).toEqual({ root: roots[0], cwd: roots[0] });
		expect(await restarted.binding("s1")).toEqual({ root: roots[1], cwd: roots[1] });
		expect(JSON.parse(readFileSync(join(agent, "channel-projects.json"), "utf8")).projects.sort()).toEqual(
			roots.sort(),
		);
		await expect(restarted.bind("s0", roots[1], roots[1])).rejects.toThrow("conflicts");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("refreshes writable peers in the same project and tolerates snapshot errors", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-peers-"));
	const other = join(root, "other");
	mkdirSync(other);
	const backend = new PiBackend();
	const internal = backend as unknown as {
		registry: { list: () => unknown[]; get: (id: string) => unknown };
		refreshChannelPeers: (id: string, cwd: string, mode: undefined) => Promise<void>;
	};
	const entries = [
		{ session: { sessionId: "sender" }, cwd: root, modeRef: {} },
		{ session: { sessionId: "peer" }, cwd: root, modeRef: {} },
		{ session: { sessionId: "readonly" }, cwd: root, modeRef: {}, readOnly: true },
		{ session: { sessionId: "other" }, cwd: other, modeRef: {} },
	];
	vi.spyOn(internal.registry, "list").mockReturnValue(entries);
	vi.spyOn(internal.registry, "get").mockImplementation((id) =>
		entries.find((entry) => entry.session.sessionId === id),
	);
	const refresh = vi
		.spyOn(backend, "getChannelSubscriptions")
		.mockRejectedValue(new Error("storage unavailable"));
	try {
		await internal.refreshChannelPeers("sender", root, undefined);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(refresh).toHaveBeenCalledWith("peer");
		expect(refresh).toHaveBeenCalledWith("other");
	} finally {
		vi.restoreAllMocks();
		await backend.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

it("persists a binding through the public backend creation entry", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-create-"));
	const agent = join(root, "agent");
	const cwd = join(root, "project", "child");
	mkdirSync(agent);
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const backend = new PiBackend({ projectTrust: false, permissionGates: false });
	try {
		await expect(backend.createSession({ cwd, channelProjectRoot: agent })).rejects.toThrow(
			"does not contain",
		);
		const session = await backend.createSession({ cwd, channelProjectRoot: join(root, "project") });
		const host = new ChannelBackendHost(agent, () => {
			throw new Error("unexpected service");
		});
		expect((await host.binding(session.sessionId))?.cwd).toBe(cwd);
	} finally {
		await backend.shutdown();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

it("refuses a different session at a fenced source", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-fence-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const backend = new PiBackend();
	const internal = backend as unknown as {
		channelService(cwd: string): Promise<ChannelService>;
		deleteSessionUnlocked(id: string, file: string): Promise<string>;
		archives: () => Promise<unknown>;
		getSessionCatalog: () => unknown;
	};
	const file = join(root, "session.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", id: "new", cwd: root })}\n`);
	internal.archives = async () => ({});
	internal.getSessionCatalog = () => ({ verify: async () => [{ status: "missing" }] });
	try {
		const service = await internal.channelService(root);
		await service.prepareMaintenance("old", "op", "delete", file);
		await expect(internal.deleteSessionUnlocked("old", file)).rejects.toThrow("identity changed");
		expect(readFileSync(file, "utf8")).toContain('"new"');
		expect(await service.pendingMaintenance()).toMatchObject([{ state: "delete" }]);
	} finally {
		await backend.shutdown();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
