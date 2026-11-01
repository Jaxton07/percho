import type { ImageInput } from "./session";

/** 仅用于展示；绝不能作为模型输入或排队载荷。环境由消费者的可信上下文绑定。 */
export interface ReferenceImage {
	kind: "reference";
	ownerSessionId: string;
	id: string;
	revision: string;
	mimeType: string;
	byteLength?: number;
}

export type DisplayImage = ImageInput | ReferenceImage;

export function isReferenceImage(value: unknown): value is ReferenceImage {
	if (!value || typeof value !== "object") return false;
	const image = value as Partial<ReferenceImage>;
	return (
		image.kind === "reference" &&
		!("data" in image) &&
		typeof image.ownerSessionId === "string" &&
		image.ownerSessionId.length > 0 &&
		typeof image.id === "string" &&
		image.id.length > 0 &&
		typeof image.revision === "string" &&
		image.revision.length > 0 &&
		typeof image.mimeType === "string" &&
		image.mimeType.length > 0 &&
		(image.byteLength === undefined || (Number.isSafeInteger(image.byteLength) && image.byteLength >= 0))
	);
}

export function isImageInput(value: unknown): value is ImageInput {
	if (!value || typeof value !== "object") return false;
	const image = value as Partial<ImageInput> & { kind?: unknown };
	return image.kind === undefined && typeof image.data === "string" && typeof image.mimeType === "string";
}

export function isDisplayImage(value: unknown): value is DisplayImage {
	return isImageInput(value) || isReferenceImage(value);
}

function normalizeDisplayImage(image: DisplayImage): DisplayImage {
	return isReferenceImage(image)
		? {
				kind: "reference",
				ownerSessionId: image.ownerSessionId,
				id: image.id,
				revision: image.revision,
				mimeType: image.mimeType,
				...(image.byteLength === undefined ? {} : { byteLength: image.byteLength }),
			}
		: { data: image.data, mimeType: image.mimeType };
}

/** 旧单图和多图共用一个提取器；保留顺序，不接受路径作为图片或透传未知详情字段。 */
export function displayImagesFromDetails(
	details: unknown,
): { images: DisplayImage[]; paths: string[] } | null {
	if (!details || typeof details !== "object") return null;
	const d = details as { images?: unknown; image?: unknown; paths?: unknown; path?: unknown };
	if (Array.isArray(d.images)) {
		const images = d.images.filter(isDisplayImage).map(normalizeDisplayImage);
		return images.length
			? {
					images,
					paths: Array.isArray(d.paths) ? d.paths.filter((p): p is string => typeof p === "string") : [],
				}
			: null;
	}
	return isDisplayImage(d.image)
		? {
				images: [normalizeDisplayImage(d.image)],
				paths: typeof d.path === "string" ? [d.path] : [],
			}
		: null;
}
