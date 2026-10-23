import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import net from "node:net";
import { getGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { testNetworkConnection } from "./network-test";

const servers: http.Server[] = [];
const sockets = new Set<Socket>();
async function listen(server: http.Server) {
	servers.push(server);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	await Promise.all(
		servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});
const settings = {
	mode: "manual" as const,
	proxyUrl: "http://127.0.0.1:1",
	noProxy: "",
	username: "",
	password: "",
};
async function proxy(expected?: string) {
	let requests = 0;
	const server = http.createServer();
	server.on("connect", (request, client, head) => {
		requests++;
		if (expected && request.headers["proxy-authorization"] !== expected) {
			client.end(
				"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=test\r\nContent-Length: 0\r\n\r\n",
			);
			return;
		}
		const address = new URL(`http://${request.url}`);
		const upstream = net.connect(Number(address.port), address.hostname, () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream);
			upstream.pipe(client);
		});
		sockets.add(upstream);
		upstream.on("close", () => sockets.delete(upstream));
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
	});
	return { url: await listen(server), count: () => requests };
}
describe("代理连接测试", () => {
	it("通过未保存代理实际请求，不修改全局配置", async () => {
		const target = await listen(http.createServer((_req, res) => res.writeHead(204).end()));
		const gateway = await proxy();
		const dispatcher = getGlobalDispatcher();
		const env = { ...process.env };
		expect(
			await testNetworkConnection({ ...settings, proxyUrl: gateway.url, noProxy: "*" }, target),
		).toMatchObject({ ok: true, latencyMs: expect.any(Number) });
		expect(gateway.count()).toBe(1);
		expect(getGlobalDispatcher()).toBe(dispatcher);
		expect(process.env).toEqual(env);
	});
	it.each(["p@ss: /?#", ""])("支持代理认证及空密码 %s", async (password) => {
		const target = await listen(http.createServer((_req, res) => res.writeHead(204).end()));
		const username = "demo";
		const gateway = await proxy(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
		expect(
			await testNetworkConnection({ ...settings, proxyUrl: gateway.url, username, password }, target),
		).toMatchObject({ ok: true });
	});
	it("错误密码返回认证错误码", async () => {
		const target = await listen(http.createServer((_req, res) => res.writeHead(204).end()));
		const gateway = await proxy("Basic expected");
		expect(
			await testNetworkConnection(
				{ ...settings, proxyUrl: gateway.url, username: "demo", password: "wrong" },
				target,
			),
		).toEqual({ ok: false, error: "authFailed" });
	});
	it("拒绝连接、超时和异常响应不误报成功", async () => {
		expect(await testNetworkConnection(settings, "http://127.0.0.1:1", 1000)).toEqual({
			ok: false,
			error: "testFailed",
		});
		const target = await listen(http.createServer(() => {}));
		const gateway = await proxy();
		expect(await testNetworkConnection({ ...settings, proxyUrl: gateway.url }, target, 50)).toEqual({
			ok: false,
			error: "testTimeout",
		});
		const failed = await listen(http.createServer((_req, res) => res.writeHead(503).end()));
		expect(await testNetworkConnection({ ...settings, proxyUrl: gateway.url }, failed)).toEqual({
			ok: false,
			error: "testFailed",
		});
	});
});
