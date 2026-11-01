export const CACHE_WARMING_MODES = ["off", "streaming", "idle"] as const;
export type CacheWarmingMode = (typeof CACHE_WARMING_MODES)[number];

export interface CacheWarmingSessionStatus {
	sessionId: string;
	name: string;
	mode: CacheWarmingMode;
	state: "inactive" | "scheduled" | "refreshing" | "unavailable";
	/** SDK 原因只在后端映射成稳定标识，不把英文实现文案直接作为 UI 文案。 */
	reason?:
		| "disabled"
		| "waiting"
		| "settled"
		| "unsupported"
		| "uneconomical"
		| "changed"
		| "limit"
		| "other";
	nextWarmAt?: number;
	phase?: "streaming" | "idle";
}

export interface CacheWarmingInfo {
	mode: CacheWarmingMode;
	sessions: CacheWarmingSessionStatus[];
}
