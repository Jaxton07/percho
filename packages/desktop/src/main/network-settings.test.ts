import { beforeEach, describe, expect, it, vi } from "vitest";

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(async (path: string) => {
		const value = files.get(path);
		if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		return value;
	}),
	writeFile: vi.fn(async (path: string, data: string) => {
		files.set(path, data);
	}),
	mkdir: vi.fn(async () => {}),
	rename: vi.fn(async (from: string, to: string) => {
		const value = files.get(from);
		if (value === undefined) throw new Error("missing temporary file");
		files.set(to, value);
		files.delete(from);
	}),
	rm: vi.fn(async () => {}),
}));
vi.mock("@percho/backend", () => import("../../../backend/src/json-store"));

import { DEFAULT_NETWORK_SETTINGS, NetworkSettingsService, parseNetworkSettings } from "./network-settings";

const manual = {
	mode: "manual" as const,
	proxyUrl: "http://127.0.0.1:7897",
	noProxy: "localhost,.example.com",
	username: "",
	password: "",
};

describe("网络设置校验", () => {
	it("规范化地址并丢弃未知字段", () => {
		expect(parseNetworkSettings({ ...manual, proxyUrl: " https://LOCALHOST:8443/ ", extra: true })).toEqual({
			...manual,
			proxyUrl: "https://localhost:8443",
		});
	});
	it.each([
		"",
		"socks5://localhost:1080",
		"localhost:7897",
		"http:localhost",
		"http://u:secret@localhost:7897",
		"http://localhost:7897/api",
		"http://localhost:7897/a/..",
		"http://localhost:7897?x=1",
		"http://localhost:7897#",
		"http://localhost:99999",
	])("拒绝不受支持的代理地址 %s", (proxyUrl) => {
		expect(() => parseNetworkSettings({ ...manual, proxyUrl })).toThrow("invalidProxyUrl");
	});
	it.each([null, [], {}, { mode: "system", proxyUrl: "", noProxy: "" }, { ...manual, proxyUrl: 1 }])(
		"校验 IPC 输入类型",
		(input) => {
			expect(() => parseNetworkSettings(input)).toThrow("invalidSettings");
		},
	);
	it("非手动模式丢弃无效草稿，始终可以切回直连", () => {
		expect(parseNetworkSettings({ mode: "direct", proxyUrl: "bad", noProxy: "bad/url" })).toEqual({
			mode: "direct",
			proxyUrl: "",
			noProxy: "",
			username: "",
			password: "",
		});
	});
	it("支持域名、IP、端口和通配符绕过项", () => {
		const noProxy = "localhost,127.0.0.1:8080,[::1],.example.com,*.example.org";
		expect(parseNetworkSettings({ ...manual, noProxy }).noProxy).toBe(noProxy);
	});
	it("统一通配符、空白和重复项语义", () => {
		expect(parseNetworkSettings({ ...manual, noProxy: " localhost, *,example.com" }).noProxy).toBe("*");
		expect(parseNetworkSettings({ ...manual, noProxy: " localhost,localhost, , 127.0.0.1 " }).noProxy).toBe(
			"localhost,127.0.0.1",
		);
	});
	it.each([
		"https://example.com",
		"10.0.0.0/8",
		"host;other",
		"a\nb",
		"host:65536",
		"host:0",
		"*:80",
		"[::::]",
	])("拒绝不受支持的绕过项 %s", (noProxy) => {
		expect(() => parseNetworkSettings({ ...manual, noProxy })).toThrow("invalidNoProxy");
	});
});

describe("网络设置持久化", () => {
	beforeEach(() => files.clear());
	it("密码加密落盘且重启后恢复", async () => {
		const codec = {
			available: () => true,
			encrypt: (value: string) => Buffer.from(value).toString("base64"),
			decrypt: (value: string) => Buffer.from(value, "base64").toString(),
		};
		const service = new NetworkSettingsService("/network.json", codec);
		await service.initialize();
		const credentials = { ...manual, username: "user", password: "test-only-secret" };
		expect(await service.save(credentials)).toMatchObject({ ok: true, status: { settings: credentials } });
		const stored = files.get("/network.json") ?? "";
		expect(stored).not.toContain(credentials.password);
		expect(JSON.parse(stored)).not.toHaveProperty("password");
		expect(JSON.parse(stored).encryptedPassword).toBe(codec.encrypt(credentials.password));
		const restarted = new NetworkSettingsService("/network.json", codec);
		expect(await restarted.initialize()).toEqual(credentials);
		expect((await restarted.load()).restartRequired).toBe(false);
		expect(await restarted.save({ ...credentials, password: "new-secret" })).toMatchObject({
			ok: true,
			status: { restartRequired: true },
		});
	});
	it("加密不可用时拒绝明文保存，允许无密码代理", async () => {
		const service = new NetworkSettingsService("/network.json");
		expect(await service.save({ ...manual, username: "user", password: "secret" })).toEqual({
			ok: false,
			error: "encryptionUnavailable",
		});
		expect(files.size).toBe(0);
		expect(await service.save({ ...manual, username: "user" })).toMatchObject({ ok: true });
	});
	it.each([false, true])("密码不可用时仍能启动并恢复配置（安全存储可用：%s）", async (available) => {
		const stored = JSON.stringify({ ...manual, username: "user", encryptedPassword: "encrypted-value" });
		files.set("/network.json", stored);
		const codec = {
			available: () => available,
			encrypt: () => "replacement-encrypted-value",
			decrypt: () => {
				throw new Error("private codec details");
			},
		};
		const service = new NetworkSettingsService("/network.json", codec);
		expect(await service.initialize()).toEqual({ ...manual, username: "user" });
		expect(await service.load()).toEqual({
			settings: { ...manual, username: "user" },
			restartRequired: false,
			passwordUnavailable: true,
		});
		expect(files.get("/network.json")).toBe(stored);
		if (available) {
			expect(await service.save({ ...manual, username: "user", password: "replacement" })).toMatchObject({
				ok: true,
				status: { restartRequired: true },
			});
			expect(files.get("/network.json")).not.toContain("private codec details");
		} else {
			expect(await service.save({ ...manual, username: "user", password: "replacement" })).toEqual({
				ok: false,
				error: "encryptionUnavailable",
			});
			expect(files.get("/network.json")).toBe(stored);
		}
	});
	it("缺省不写盘；保存仅影响下次启动，重启后清除提示", async () => {
		const service = new NetworkSettingsService("/network.json");
		expect(await service.initialize()).toEqual(DEFAULT_NETWORK_SETTINGS);
		expect(files.size).toBe(0);
		expect(await service.save(manual)).toMatchObject({
			ok: true,
			status: { settings: manual, restartRequired: true },
		});
		const { password: _, ...stored } = manual;
		expect(JSON.parse(files.get("/network.json") ?? "null")).toEqual(stored);
		expect(await service.load()).toEqual({ settings: manual, restartRequired: true });
		const restarted = new NetworkSettingsService("/network.json");
		expect(await restarted.initialize()).toEqual(manual);
		expect((await restarted.load()).restartRequired).toBe(false);
	});
	it("恢复本次启动配置时清除重启提示", async () => {
		const service = new NetworkSettingsService("/network.json");
		await service.initialize();
		await service.save(manual);
		expect(await service.save(DEFAULT_NETWORK_SETTINGS)).toMatchObject({
			ok: true,
			status: { restartRequired: false },
		});
	});
	it("错误返回码不包含代理凭证，也不写入磁盘", async () => {
		const service = new NetworkSettingsService("/network.json");
		expect(await service.save({ ...manual, proxyUrl: "http://u:secret@localhost" })).toEqual({
			ok: false,
			error: "invalidProxyUrl",
		});
		expect(files.size).toBe(0);
	});
	it("损坏文件回退默认值，但拒绝覆盖原文件", async () => {
		files.set("/network.json", "{broken");
		const service = new NetworkSettingsService("/network.json");
		expect(await service.initialize()).toEqual(DEFAULT_NETWORK_SETTINGS);
		await expect(service.save(manual)).rejects.toThrow("配置文件损坏");
		expect(files.get("/network.json")).toBe("{broken");
	});
	it("并发保存按调用顺序完整落盘", async () => {
		const service = new NetworkSettingsService("/network.json");
		await service.initialize();
		await Promise.all([service.save(manual), service.save({ ...DEFAULT_NETWORK_SETTINGS, mode: "direct" })]);
		expect(JSON.parse(files.get("/network.json") ?? "null").mode).toBe("direct");
	});
});
