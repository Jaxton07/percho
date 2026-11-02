import {
	type DisplayImage,
	type EnvironmentRef,
	environmentEntityRef,
	isReferenceImage,
	sameEnvironment,
} from "@percho/shared";

type Invalidation = { ownerSessionId: string } | { environment: EnvironmentRef };
const listeners = new Set<(event: Invalidation) => void>();
/** 只持有挂载消费者的订阅，不建立持久图片/环境身份表。 */
export function subscribeImageInvalidation(image: DisplayImage, invalidate: () => void): () => void {
	if (!isReferenceImage(image)) return () => {};
	const owner = image.ownerSessionId;
	const listener = (event: Invalidation) => {
		if ("ownerSessionId" in event) {
			if (owner === event.ownerSessionId) invalidate();
			return;
		}
		try {
			if (sameEnvironment(environmentEntityRef(owner).environment, event.environment)) invalidate();
		} catch {
			invalidate();
		}
	};
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function notifyImageInvalidation(event: Invalidation): void {
	for (const listener of [...listeners]) {
		try {
			listener(event);
		} catch {
			/* 单个视图不能阻断其他来源的清理。 */
		}
	}
}
export const imageInvalidationListenerCount = () => listeners.size;
