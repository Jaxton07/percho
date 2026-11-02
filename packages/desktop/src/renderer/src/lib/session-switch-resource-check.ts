import type { SessionSwitchProbe } from "@percho/shared";
import {
	ACTIVE_SLOT_LIMIT,
	CACHE_BYTE_LIMIT,
	CACHE_ENTRY_LIMIT,
	WAITING_LIMIT,
} from "../components/chat/history-image/constants";
import type { ThumbnailService } from "../components/chat/history-image/history-image-service";

type Resources = ReturnType<ThumbnailService["stats"]>;
/** 验收必须复用产品真实预算，不能另设更宽阈值。 */
export function assertSwitchResourceBudget(resources: Resources, activeReads: number): void {
	if (
		resources.active > ACTIVE_SLOT_LIMIT ||
		resources.waiting > WAITING_LIMIT ||
		resources.outstandingRequests > 1 ||
		resources.cacheEntries > CACHE_ENTRY_LIMIT ||
		resources.cacheBytes > CACHE_BYTE_LIMIT ||
		resources.urls > ACTIVE_SLOT_LIMIT ||
		activeReads > 2
	)
		throw new Error("Image resource budget exceeded");
}
export function assertSwitchResourcesReleased(
	resources: Resources,
	source: SessionSwitchProbe["source"],
): void {
	assertSwitchResourceBudget(resources, 0);
	if (
		resources.active !== 0 ||
		resources.waiting !== 0 ||
		resources.urls !== 0 ||
		resources.inFlight ||
		resources.outstandingRequests !== 0 ||
		source?.views !== 0 ||
		source.metadata > 128
	)
		throw new Error("Source or image resources retained after SDK GC");
}
