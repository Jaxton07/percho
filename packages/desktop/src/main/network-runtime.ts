import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { NetworkSettings } from "@percho/shared";
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** 凭据只在请求时拼入进程内代理地址，不写入磁盘或日志。 */
export function authenticatedProxyUrl(settings: NetworkSettings): string {
	if (!settings.username) return settings.proxyUrl;
	const url = new URL(settings.proxyUrl);
	url.username = settings.username;
	url.password = settings.password;
	return url.toString();
}

export function createNetworkDispatcher(settings: NetworkSettings, env: NodeJS.ProcessEnv = process.env) {
	if (settings.mode === "direct") return new Agent();
	const options =
		settings.mode === "manual"
			? {
					httpProxy: settings.proxyUrl,
					httpsProxy: settings.proxyUrl,
					noProxy: settings.noProxy,
					token: settings.username
						? `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString("base64")}`
						: undefined,
				}
			: {
					httpProxy: env.http_proxy || env.HTTP_PROXY || "",
					httpsProxy: env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || "",
					noProxy: env.no_proxy || env.NO_PROXY || "",
				};
	return new EnvHttpProxyAgent(options);
}

export function matchesProxyAuth(
	settings: NetworkSettings,
	auth: { isProxy: boolean; host: string; port: number },
): boolean {
	if (settings.mode !== "manual" || !settings.username || !auth.isProxy) return false;
	const url = new URL(settings.proxyUrl);
	return (
		auth.host.toLowerCase().replace(/^\[|\]$/g, "") === url.hostname.toLowerCase().replace(/^\[|\]$/g, "") &&
		auth.port === Number(url.port || (url.protocol === "https:" ? 443 : 80))
	);
}

const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
] as const;

/** 仅修改 Percho 及其后续子进程的环境，不修改操作系统代理或用户环境变量。 */
export function configureProxyEnvironment(settings: NetworkSettings, env: NodeJS.ProcessEnv): void {
	if (settings.mode === "environment") return;
	for (const key of PROXY_ENV_KEYS) delete env[key];
	env.NODE_USE_ENV_PROXY = settings.mode === "manual" ? "1" : "0";
	if (settings.mode === "manual") {
		env.HTTP_PROXY = env.http_proxy = authenticatedProxyUrl(settings);
		env.HTTPS_PROXY = env.https_proxy = authenticatedProxyUrl(settings);
		env.NO_PROXY = env.no_proxy = settings.noProxy;
	}
}

/** Chromium 默认绕过 loopback；显式移除此隐式规则，交给用户的 NO_PROXY 决定。 */
export function chromiumBypassRules(noProxy: string): string {
	const rules = noProxy
		.split(",")
		.map((rule) => rule.trim())
		.filter(Boolean);
	return [
		"<-loopback>",
		...rules.flatMap((rule) => {
			if (rule === "*" || rule.startsWith("[")) return [rule];
			const host = rule.replace(/^\*?\./, "");
			if (isIP(host.replace(/:\d+$/, ""))) return [host];
			return [host, `*.${host}`];
		}),
	].join(";");
}

interface ChromiumSession {
	setProxy(config: {
		mode: "system" | "direct" | "fixed_servers";
		proxyRules?: string;
		proxyBypassRules?: string;
	}): Promise<void>;
}

/** 必须在 PiBackend / updater 初始化之前执行；setProxy 单独不能覆盖 Node fetch。 */
export async function applyNetworkSettings(
	settings: NetworkSettings,
	chromium: ChromiumSession,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	configureProxyEnvironment(settings, env);
	const direct = settings.mode === "direct";
	setGlobalDispatcher(createNetworkDispatcher(settings, env));
	// 显式重建全局 Agent，保证直连模式也能覆盖启动时 NODE_USE_ENV_PROXY=1 的状态。
	const proxyEnv = direct ? {} : { ...env };
	http.globalAgent = new http.Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000, proxyEnv });
	https.globalAgent = new https.Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000, proxyEnv });
	if (settings.mode === "manual") {
		await chromium.setProxy({
			mode: "fixed_servers",
			proxyRules: settings.proxyUrl,
			proxyBypassRules: chromiumBypassRules(settings.noProxy),
		});
	} else {
		await chromium.setProxy({ mode: direct ? "direct" : "system" });
	}
}
