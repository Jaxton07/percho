import { mkdtemp, rm } from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LanConfigService } from "../src/lan/config";
import type { LanObserverBackend } from "../src/lan/server";
import { LanObserverServer } from "../src/lan/server";

const token = Buffer.from("0123456789ab").toString("base64url");
const servers: LanObserverServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function backend(): LanObserverBackend {
	const session = {
		sessionId: "session-1",
		cwd: "/work",
		name: "LAN test",
		active: true,
		messageCount: 1,
		createdAt: 1,
		modifiedAt: 2,
	};
	return {
		listAllSessions: async () => [session],
		getSessionMessages: async () => [{ role: "assistant", text: "hello" }] as never,
		getTodos: async () => [{ content: "ship", status: "in_progress" }],
		getStats: async () => ({ inputTokens: 1, outputTokens: 2, cost: 0.01 }),
		listActiveSessionRuntime: () => [{ sessionId: session.sessionId, streaming: true, compacting: false }],
		getPendingPermissionRequests: () => [],
		onEvent: () => () => {},
		onPermissionRequest: () => () => {},
		onPermissionResolved: () => () => {},
	};
}

async function start(port = 0, observer: LanObserverBackend = backend()): Promise<LanObserverServer> {
	const dir = await mkdtemp(join(tmpdir(), "percho-lan-"));
	dirs.push(dir);
	const config = new LanConfigService(join(dir, "lan-observer.json"));
	await config.save({ enabled: true, port, token });
	const server = new LanObserverServer(observer, config, { pageHtml: "<h1>observer</h1>" });
	servers.push(server);
	await server.start();
	return server;
}

function request(url: string): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		get(url, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
		}).on("error", reject);
	});
}

function sse(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = get(url, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				text += chunk;
				if (text.includes("event: hello") && text.includes("event: view")) {
					req.destroy();
					resolve(text);
				}
			});
		});
		req.on("error", reject);
	});
}

describe("LanObserverServer", () => {
	it("requires a valid token and serves snapshot plus SSE", async () => {
		const server = await start();
		const port = server.status().port;
		expect(port).not.toBeNull();
		await expect(request(`http://127.0.0.1:${port}/api/snapshot`)).resolves.toMatchObject({ status: 401 });
		await expect(request(`http://127.0.0.1:${port}/api/snapshot?t=bad`)).resolves.toMatchObject({
			status: 401,
		});
		await expect(request(`http://127.0.0.1:${port}/`)).resolves.toMatchObject({
			status: 200,
			text: "<h1>observer</h1>",
		});
		const snapshot = await request(`http://127.0.0.1:${port}/api/snapshot?t=${token}`);
		expect(snapshot.status).toBe(200);
		expect(JSON.parse(snapshot.text)).toMatchObject({
			list: [{ sessionId: "session-1" }],
			views: [{ sessionId: "session-1", assistantTail: "hello", agentActive: true }],
		});
		await expect(sse(`http://127.0.0.1:${port}/api/stream?t=${token}`)).resolves.toContain("event: view");
	});

	it("drops unknown subagent events after one bounded seed attempt", async () => {
		let listCalls = 0;
		let eventHandler: ((sessionId: string, event: never) => void) | undefined;
		const observer: LanObserverBackend = {
			...backend(),
			listAllSessions: async () => {
				listCalls++;
				return [];
			},
			onEvent: (handler) => {
				eventHandler = handler as (sessionId: string, event: never) => void;
				return () => {};
			},
		};
		const server = await start(0, observer);
		for (let index = 0; index < 200; index++) {
			eventHandler?.("subagent-session", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
			} as never);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		const pending = (server as unknown as { pendingEvents: Map<string, unknown[]> }).pendingEvents;
		expect(listCalls).toBeLessThanOrEqual(2);
		expect(pending.size).toBe(0);
	});

	it("retries an occupied expected port and releases its actual port on stop", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "0.0.0.0", resolve));
		const port = (blocker.address() as { port: number }).port;
		const server = await start(port);
		expect(server.status().port).toBe(port + 1);
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
		const actualPort = server.status().port as number;
		await server.stop();
		servers.splice(servers.indexOf(server), 1);
		const replacement = createServer();
		await new Promise<void>((resolve) => replacement.listen(actualPort, "0.0.0.0", resolve));
		await new Promise<void>((resolve) => replacement.close(() => resolve()));
	});
});
