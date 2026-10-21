/** 应用级网络设置；只在进程启动时应用，避免中断正在进行的流式请求。 */
export interface NetworkSettings {
	mode: "environment" | "manual" | "direct";
	proxyUrl: string;
	noProxy: string;
	username: string;
	password: string;
}

export type NetworkSettingsError =
	| "invalidSettings"
	| "invalidProxyUrl"
	| "invalidNoProxy"
	| "invalidCredentials"
	| "encryptionUnavailable";

export type NetworkTestResult =
	| { ok: true; latencyMs: number }
	| { ok: false; error: NetworkSettingsError | "testFailed" | "testTimeout" | "authFailed" };

export interface NetworkSettingsStatus {
	settings: NetworkSettings;
	restartRequired: boolean;
	passwordUnavailable?: boolean;
}

export type NetworkSettingsSaveResult =
	| { ok: true; status: NetworkSettingsStatus }
	| { ok: false; error: NetworkSettingsError };
