import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({
	Agent: vi.fn(() => {}),
	EnvHttpProxyAgent: vi.fn((_options: unknown) => {}),
	setGlobalDispatcher: vi.fn(),
}));

import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import {
	applyNetworkSettings,
	authenticatedProxyUrl,
	chromiumBypassRules,
	configureProxyEnvironment,
	matchesProxyAuth,
} from "./network-runtime";

const manual = {
	mode: "manual" as const,
	proxyUrl: "http://127.0.0.1:7897",
	noProxy: "localhost",
	username: "",
	password: "",
};
const originalHttp = http.globalAgent;
const originalHttps = https.globalAgent;
function proxyEnv(agent: object) {
	return (agent as { options: http.AgentOptions }).options.proxyEnv;
}
afterEach(() => {
	if (http.globalAgent !== originalHttp) http.globalAgent.destroy();
	if (https.globalAgent !== originalHttps) https.globalAgent.destroy();
	http.globalAgent = originalHttp;
	https.globalAgent = originalHttps;
	vi.clearAllMocks();
});

describe("代理环境变量", () => {
	it("默认模式保留现有环境", () => {
		const env = { HTTP_PROXY: "http://proxy:1", https_proxy: "http://proxy:2", NO_PROXY: "internal" };
		const snapshot = { ...env };
		configureProxyEnvironment({ ...manual, mode: "environment" }, env);
		expect(env).toEqual(snapshot);
	});
	it("手动模式统一大小写并清除 ALL_PROXY / 旧绕过项", () => {
		const env: NodeJS.ProcessEnv = {
			HTTP_PROXY: "old",
			https_proxy: "old",
			all_proxy: "socks://old",
			ALL_PROXY: "old",
			no_proxy: "*",
			OTHER: "kept",
		};
		configureProxyEnvironment(manual, env);
		expect(env).toEqual({
			HTTP_PROXY: manual.proxyUrl,
			http_proxy: manual.proxyUrl,
			HTTPS_PROXY: manual.proxyUrl,
			https_proxy: manual.proxyUrl,
			NO_PROXY: "localhost",
			no_proxy: "localhost",
			NODE_USE_ENV_PROXY: "1",
			OTHER: "kept",
		});
	});
	it("直连模式清除大小写代理变量和启动开关", () => {
		const env: NodeJS.ProcessEnv = {
			HTTP_PROXY: "old",
			http_proxy: "old",
			HTTPS_PROXY: "old",
			https_proxy: "old",
			ALL_PROXY: "old",
			all_proxy: "old",
			NO_PROXY: "*",
			no_proxy: "*",
			NODE_USE_ENV_PROXY: "1",
		};
		configureProxyEnvironment({ ...manual, mode: "direct" }, env);
		expect(env).toEqual({ NODE_USE_ENV_PROXY: "0" });
	});
});

describe("网络运行时", () => {
	it("同时初始化 fetch、HTTP(S) 和 Chromium 代理", async () => {
		const chromium = { setProxy: vi.fn().mockResolvedValue(undefined) };
		await applyNetworkSettings(manual, chromium, {});
		expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
			httpProxy: manual.proxyUrl,
			httpsProxy: manual.proxyUrl,
			noProxy: manual.noProxy,
			token: undefined,
		});
		expect(setGlobalDispatcher).toHaveBeenCalledOnce();
		expect(proxyEnv(http.globalAgent)).toMatchObject({ HTTP_PROXY: manual.proxyUrl });
		expect(proxyEnv(https.globalAgent)).toMatchObject({ HTTPS_PROXY: manual.proxyUrl });
		expect(chromium.setProxy).toHaveBeenCalledWith({
			mode: "fixed_servers",
			proxyRules: manual.proxyUrl,
			proxyBypassRules: "<-loopback>;localhost;*.localhost",
		});
	});
	it("直连重建全部全局连接器，覆盖启动时已启用的代理", async () => {
		const chromium = { setProxy: vi.fn().mockResolvedValue(undefined) };
		await applyNetworkSettings({ ...manual, mode: "direct" }, chromium, {
			NODE_USE_ENV_PROXY: "1",
			HTTP_PROXY: "http://old:1",
		});
		expect(Agent).toHaveBeenCalledOnce();
		expect(EnvHttpProxyAgent).not.toHaveBeenCalled();
		expect(http.globalAgent).not.toBe(originalHttp);
		expect(proxyEnv(http.globalAgent)).toEqual({});
		expect(proxyEnv(https.globalAgent)).toEqual({});
		expect(chromium.setProxy).toHaveBeenCalledWith({ mode: "direct" });
	});
	it("环境模式尊重小写优先级并保留 Chromium 系统代理", async () => {
		const chromium = { setProxy: vi.fn().mockResolvedValue(undefined) };
		await applyNetworkSettings({ ...manual, mode: "environment" }, chromium, {
			http_proxy: "http://lower:1",
			HTTP_PROXY: "http://upper:2",
			NO_PROXY: "internal",
		});
		expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
			httpProxy: "http://lower:1",
			httpsProxy: "http://lower:1",
			noProxy: "internal",
		});
		expect(chromium.setProxy).toHaveBeenCalledWith({ mode: "system" });
	});
	it("绕过列表兼容域名后缀与可选端口", () => {
		expect(chromiumBypassRules(".example.com, *.example.org:443, [::1], *")).toBe(
			"<-loopback>;example.com;*.example.com;example.org:443;*.example.org:443;[::1];*",
		);
	});
	it("IP 不生成无意义的子域通配符", () => {
		expect(chromiumBypassRules("127.0.0.1:8080,[::1]")).toBe("<-loopback>;127.0.0.1:8080;[::1]");
	});
	it("编码代理凭据，只回答匹配代理的认证挑战", () => {
		const settings = { ...manual, username: "user@demo", password: "p:a/ss?#" };
		const url = new URL(authenticatedProxyUrl(settings));
		expect(decodeURIComponent(url.username)).toBe(settings.username);
		expect(decodeURIComponent(url.password)).toBe(settings.password);
		expect(matchesProxyAuth(settings, { isProxy: true, host: "127.0.0.1", port: 7897 })).toBe(true);
		expect(matchesProxyAuth(settings, { isProxy: false, host: "127.0.0.1", port: 7897 })).toBe(false);
		expect(matchesProxyAuth(settings, { isProxy: true, host: "other", port: 7897 })).toBe(false);
		expect(matchesProxyAuth(settings, { isProxy: true, host: "127.0.0.1", port: 7898 })).toBe(false);
	});
});
