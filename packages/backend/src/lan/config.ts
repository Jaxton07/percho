import { randomBytes } from "node:crypto";
import type { LanObserverConfig } from "@percho/shared";
import { JsonStore } from "../json-store";

const DEFAULT_CONFIG: LanObserverConfig = { enabled: false, port: 7331, token: null, remoteControl: false };

/** userData/lan-observer.json 的原子持久化与字段规整。 */
export class LanConfigService {
	private cache: LanObserverConfig | null = null;

	constructor(private readonly configPath: string) {}

	private store(): JsonStore<Partial<LanObserverConfig>> {
		return new JsonStore<Partial<LanObserverConfig>>({ path: this.configPath, defaultValue: () => ({}) });
	}

	async load(): Promise<LanObserverConfig> {
		if (this.cache) return this.cache;
		const raw = await this.store().read();
		const config: LanObserverConfig = {
			enabled: raw.enabled === true,
			port: validPort(raw.port) ? raw.port : DEFAULT_CONFIG.port,
			token: typeof raw.token === "string" && raw.token.length > 0 ? raw.token : null,
			// 旧配置缺字段 → false（M2 二级开关，缺省关）
			remoteControl: raw.remoteControl === true,
		};
		this.cache = config;
		return config;
	}

	/** 同步读缓存（首次 load 之前为 null）；server.status() 等同步路径用。 */
	cached(): LanObserverConfig | null {
		return this.cache;
	}

	async save(patch: Partial<LanObserverConfig>): Promise<LanObserverConfig> {
		const current = await this.load();
		const next: LanObserverConfig = {
			enabled: patch.enabled ?? current.enabled,
			port: patch.port === undefined ? current.port : validPort(patch.port) ? patch.port : current.port,
			token: patch.token === undefined ? current.token : patch.token,
			remoteControl: patch.remoteControl ?? current.remoteControl,
		};
		this.cache = next;
		await this.store().write(next);
		return next;
	}

	/** 每次启用前轮换 token，并原子写盘。 */
	async rotateToken(): Promise<string> {
		const token = randomBytes(12).toString("base64url");
		await this.save({ token });
		return token;
	}
}

function validPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}
