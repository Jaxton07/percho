import { isIP } from "node:net";
import { JsonStore } from "@percho/backend";
import type {
	NetworkSettings,
	NetworkSettingsError,
	NetworkSettingsSaveResult,
	NetworkSettingsStatus,
} from "@percho/shared";

export const DEFAULT_NETWORK_SETTINGS: Readonly<NetworkSettings> = {
	mode: "environment",
	proxyUrl: "",
	noProxy: "",
	username: "",
	password: "",
};

export interface NetworkSecretCodec {
	available(): boolean;
	encrypt(value: string): string;
	decrypt(value: string): string;
}

type StoredNetworkSettings = Omit<NetworkSettings, "password"> & { encryptedPassword?: string };

class InvalidNetworkSettings extends Error {
	constructor(readonly code: NetworkSettingsError) {
		super(code);
	}
}

/** 不将用户输入嵌入错误信息，避免代理凭证被 IPC / 日志回显。 */
export function parseNetworkSettings(value: unknown): NetworkSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new InvalidNetworkSettings("invalidSettings");
	}
	const raw = value as Record<string, unknown>;
	if (
		(raw.mode !== "environment" && raw.mode !== "manual" && raw.mode !== "direct") ||
		typeof raw.proxyUrl !== "string" ||
		(raw.noProxy !== undefined && typeof raw.noProxy !== "string") ||
		(raw.username !== undefined && typeof raw.username !== "string") ||
		(raw.password !== undefined && typeof raw.password !== "string")
	) {
		throw new InvalidNetworkSettings("invalidSettings");
	}
	const mode = raw.mode as NetworkSettings["mode"];
	let proxyUrl = raw.proxyUrl.trim();
	const username = ((raw.username as string | undefined) ?? "").trim();
	const password = (raw.password as string | undefined) ?? "";
	const noProxyEntries = ((raw.noProxy as string | undefined) ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (mode !== "manual") return { mode, proxyUrl: "", noProxy: "", username: "", password: "" };
	if ((!username && password) || /[:\r\n\0]/.test(username) || /[\r\n\0]/.test(password)) {
		throw new InvalidNetworkSettings("invalidCredentials");
	}
	if (proxyUrl) {
		try {
			const url = new URL(proxyUrl);
			if (
				!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(proxyUrl) ||
				!url.hostname ||
				url.username ||
				url.password ||
				url.pathname !== "/" ||
				url.search ||
				url.hash ||
				/[\s\\?#]/.test(proxyUrl)
			) {
				throw new Error();
			}
			proxyUrl = url.origin;
		} catch {
			throw new InvalidNetworkSettings("invalidProxyUrl");
		}
	} else {
		throw new InvalidNetworkSettings("invalidProxyUrl");
	}
	// Node NO_PROXY 的共同子集：域名、IP、可选端口、前导点/通配符；不接受 PAC/CIDR。
	if (
		noProxyEntries.some((token) => {
			if (token === "*") return false;
			const match =
				/^(\[[a-fA-F0-9:]+\]|(?:\*\.)?\.?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)(?::(\d{1,5}))?$/.exec(token);
			if (!match) return true;
			const host = match[1] ?? "";
			if (host.startsWith("[") && isIP(host.slice(1, -1)) !== 6) return true;
			return match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535);
		})
	) {
		throw new InvalidNetworkSettings("invalidNoProxy");
	}
	const noProxy = noProxyEntries.includes("*") ? "*" : [...new Set(noProxyEntries)].join(",");
	return { mode, proxyUrl, noProxy, username, password };
}

/** 保存不改变运行中的连接；重启提示以本次启动时的快照为准。 */
export class NetworkSettingsService {
	private readonly store: JsonStore<StoredNetworkSettings>;
	private active: NetworkSettings = { ...DEFAULT_NETWORK_SETTINGS };

	constructor(
		path: string,
		private readonly secrets?: NetworkSecretCodec,
	) {
		this.store = new JsonStore({
			path,
			mode: 0o600,
			defaultValue: () => {
				const { password: _, ...settings } = DEFAULT_NETWORK_SETTINGS;
				return settings;
			},
			parse: (text) => {
				try {
					const raw = JSON.parse(text);
					const { password: _, ...settings } = parseNetworkSettings(raw);
					if (raw.encryptedPassword !== undefined && typeof raw.encryptedPassword !== "string")
						throw new Error();
					return {
						...settings,
						...(raw.encryptedPassword ? { encryptedPassword: raw.encryptedPassword } : {}),
					};
				} catch {
					throw new InvalidNetworkSettings("invalidSettings");
				}
			},
		});
	}

	async initialize(): Promise<NetworkSettings> {
		this.active = (await this.readSettings()).settings;
		return { ...this.active };
	}

	async load(): Promise<NetworkSettingsStatus> {
		const { settings, passwordUnavailable } = await this.readSettings();
		return { ...this.status(settings), ...(passwordUnavailable ? { passwordUnavailable: true } : {}) };
	}

	private async readSettings(): Promise<{ settings: NetworkSettings; passwordUnavailable?: true }> {
		const { encryptedPassword, ...settings } = await this.store.read();
		if (!encryptedPassword) return { settings: { ...settings, password: "" } };
		try {
			if (!this.secrets?.available()) throw new Error("encryptionUnavailable");
			return { settings: { ...settings, password: this.secrets.decrypt(encryptedPassword) } };
		} catch {
			// 保留代理路由和磁盘上的密文，允许用户打开设置重新填写密码。
			return { settings: { ...settings, password: "" }, passwordUnavailable: true };
		}
	}

	async save(input: unknown): Promise<NetworkSettingsSaveResult> {
		let settings: NetworkSettings;
		try {
			settings = parseNetworkSettings(input);
		} catch (error) {
			if (error instanceof InvalidNetworkSettings) return { ok: false, error: error.code };
			throw error;
		}
		if (settings.password && !this.secrets?.available()) return { ok: false, error: "encryptionUnavailable" };
		const { password, ...publicSettings } = settings;
		const encryptedPassword = password ? this.secrets?.encrypt(password) : undefined;
		await this.store.update(() => ({
			...publicSettings,
			...(encryptedPassword ? { encryptedPassword } : {}),
		}));
		return { ok: true, status: this.status(settings) };
	}

	private status(settings: NetworkSettings): NetworkSettingsStatus {
		const restartRequired =
			settings.mode !== this.active.mode ||
			(settings.mode === "manual" &&
				(settings.proxyUrl !== this.active.proxyUrl ||
					settings.noProxy !== this.active.noProxy ||
					settings.username !== this.active.username ||
					settings.password !== this.active.password));
		return { settings, restartRequired };
	}
}
