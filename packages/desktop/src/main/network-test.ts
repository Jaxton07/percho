import type { NetworkSettings, NetworkSettingsError, NetworkTestResult } from "@percho/shared";
import { type Dispatcher, request } from "undici";
import { createNetworkDispatcher } from "./network-runtime";
import { parseNetworkSettings } from "./network-settings";

/** 测试当前草稿，不保存配置、不切换全局代理，也不调用付费模型。 */
export async function testNetworkConnection(
	input: unknown,
	target = "https://www.gstatic.com/generate_204",
	timeoutMs = 10000,
): Promise<NetworkTestResult> {
	let settings: NetworkSettings;
	try {
		settings = parseNetworkSettings(input);
		if (settings.mode === "manual") settings.noProxy = "";
	} catch (error) {
		return { ok: false, error: (error as { code: NetworkSettingsError }).code ?? "invalidSettings" };
	}
	const started = performance.now();
	const signal = AbortSignal.timeout(timeoutMs);
	let dispatcher: Dispatcher | undefined;
	try {
		dispatcher = createNetworkDispatcher(settings);
		const response = await request(target, {
			dispatcher,
			signal,
			method: "HEAD",
			headersTimeout: timeoutMs,
			bodyTimeout: timeoutMs,
		});
		await response.body.dump();
		if (response.statusCode === 407) return { ok: false, error: "authFailed" };
		if (response.statusCode < 200 || response.statusCode >= 400) return { ok: false, error: "testFailed" };
		return { ok: true, latencyMs: Math.max(1, Math.round(performance.now() - started)) };
	} catch (error) {
		// 仅返回固定错误码，代理地址和密码不经 IPC / 日志回显。
		const message = error instanceof Error ? error.message : "";
		return {
			ok: false,
			error: signal.aborted
				? "testTimeout"
				: /407|authentication|statusCode=407/i.test(message)
					? "authFailed"
					: "testFailed",
		};
	} finally {
		await dispatcher?.destroy().catch(() => {});
	}
}
