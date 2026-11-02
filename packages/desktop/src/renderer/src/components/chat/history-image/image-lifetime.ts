import type { EnvironmentRef } from "@percho/shared";
import { thumbnailService } from "./history-image-service";
import { notifyImageInvalidation } from "./image-invalidation";
import { imageReader } from "./image-reader";

/** 来源失效与视图换代不同：清所属缓存/读取/预览，不触碰其他环境。 */
export function invalidateImageEnvironment(environment: EnvironmentRef): void {
	notifyImageInvalidation({ environment });
	thumbnailService().invalidateEnvironment(environment);
	imageReader.invalidateEnvironment(environment);
}
export function invalidateImageOwner(ownerSessionId: string): void {
	notifyImageInvalidation({ ownerSessionId });
	thumbnailService().invalidateOwner(ownerSessionId);
	imageReader.invalidateOwner(ownerSessionId);
}
