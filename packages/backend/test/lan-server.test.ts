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

/** 收集 SSE 流直到 predicate 命中或超时；返回已收到的原始文本。 */
function sseCollect(url: string, predicate: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			req.destroy();
			reject(new Error(`sseCollect timeout; received:\n${text}`));
		}, timeoutMs);
		let text = "";
		const req = get(url, (res) => {
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				text += chunk;
				if (predicate(text)) {
					clearTimeout(timer);
					req.destroy();
					resolve(text);
				}
			});
		});
		req.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
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

	it("snapshot carries sanitized transcripts, remoteControl and snapshotSeq", async () => {
		const observer: LanObserverBackend = {
			...backend(),
			getSessionMessages: async () =>
				[
					{
						role: "user",
						text: "hi",
						thinking: "",
						tools: [],
						images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
						timestamp: 1,
						sourceText: "secret source",
					},
					{ role: "assistant", text: "hello", thinking: "", tools: [], images: [], timestamp: 2 },
				] as never,
		};
		const server = await start(0, observer);
		const port = server.status().port;
		const res = await request(`http://127.0.0.1:${port}/api/snapshot?t=${token}`);
		const snapshot = JSON.parse(res.text);
		expect(snapshot.remoteControl).toBe(false);
		expect(typeof snapshot.snapshotSeq).toBe("number");
		expect(snapshot.transcripts).toHaveLength(1);
		const transcript = snapshot.transcripts[0];
		expect(transcript.sessionId).toBe("session-1");
		expect(transcript.truncated).toBe(false);
		const user = transcript.messages[0];
		expect(user.sourceText).toBeUndefined();
		expect(user.images[0].data).toBe("lan-image-stripped");
		expect(transcript.messages[1].text).toBe("hello");
	});

	it("relays sanitized event frames for known sessions with 50ms delta batching", async () => {
		let eventHandler: ((sessionId: string, event: never) => void) | undefined;
		const observer: LanObserverBackend = {
			...backend(),
			onEvent: (handler) => {
				eventHandler = handler as (sessionId: string, event: never) => void;
				return () => {};
			},
		};
		const server = await start(0, observer);
		const port = server.status().port;
		const collected = sseCollect(
			`http://127.0.0.1:${port}/api/stream?t=${token}`,
			(text) => text.includes("event: event") && text.includes("agent_start"),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		// 连续 3 个同 contentIndex 的 text_delta 应合并为一帧
		for (const delta of ["你", "好", "呀"]) {
			eventHandler?.("session-1", {
				type: "message_update",
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			} as never);
		}
		// 非 delta 事件即时转发
		eventHandler?.("session-1", { type: "agent_start" } as never);
		const text = await collected;
		const frames = [...text.matchAll(/^event: event\ndata: (.+)$/gm)].map((m) => JSON.parse(m[1] ?? ""));
		expect(frames).toHaveLength(2);
		expect(frames[0].event.assistantMessageEvent.delta).toBe("你好呀");
		expect(frames[1].event.type).toBe("agent_start");
		expect(frames[0].seq).toBeLessThan(frames[1].seq);
	});

	it("does not relay event frames for unknown (subagent) sessions", async () => {
		let eventHandler: ((sessionId: string, event: never) => void) | undefined;
		const observer: LanObserverBackend = {
			...backend(),
			onEvent: (handler) => {
				eventHandler = handler as (sessionId: string, event: never) => void;
				return () => {};
			},
		};
		const server = await start(0, observer);
		const port = server.status().port;
		let text = "";
		await new Promise<void>((resolve, reject) => {
			const req = get(`http://127.0.0.1:${port}/api/stream?t=${token}`, (res) => {
				res.setEncoding("utf8");
				res.on("data", (chunk) => (text += chunk));
				setTimeout(() => {
					req.destroy();
					resolve();
				}, 300);
			});
			req.on("error", reject);
		});
		for (let index = 0; index < 50; index++) {
			eventHandler?.("subagent-session", {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
			} as never);
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(text).not.toContain("event: event");
	});

	it("broadcasts perm and perm_resolved frames", async () => {
		let requestHandler: ((req: never) => void) | undefined;
		let resolvedHandler: ((result: never) => void) | undefined;
		const observer: LanObserverBackend = {
			...backend(),
			onPermissionRequest: (handler) => {
				requestHandler = handler as (req: never) => void;
				return () => {};
			},
			onPermissionResolved: (handler) => {
				resolvedHandler = handler as (result: never) => void;
				return () => {};
			},
		};
		const server = await start(0, observer);
		const port = server.status().port;
		const collected = sseCollect(`http://127.0.0.1:${port}/api/stream?t=${token}`, (text) =>
			text.includes("event: perm_resolved"),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		requestHandler?.({
			id: "req-1",
			sessionId: "session-1",
			title: "写文件",
			message: "edit /work/a.ts",
			kind: "path",
			suggestDir: "/work",
		} as never);
		resolvedHandler?.({ sessionId: "session-1", requestId: "req-1", answered: true } as never);
		const text = await collected;
		const perm = /event: perm\ndata: (.+)/.exec(text);
		const resolved = /event: perm_resolved\ndata: (.+)/.exec(text);
		expect(perm).not.toBeNull();
		expect(JSON.parse(perm?.[1] ?? "")).toMatchObject({
			sessionId: "session-1",
			request: { id: "req-1", title: "写文件", kind: "path", suggestDir: "/work" },
		});
		expect(JSON.parse(resolved?.[1] ?? "")).toMatchObject({ requestId: "req-1", answered: true });
	});
});
