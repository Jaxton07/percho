import type { ComposerPart } from "@percho/shared";
import { resolveDroppedFilePaths } from "./drop-files";

export interface PastePlan {
	/** 已在光标处落成文件引用的原生路径 */
	paths: string[];
	/** 继续走图片管线的图片 */
	images: File[];
	/** 远端会话丢弃了本机文件（本机路径不能当远端路径用） */
	remoteRejected: boolean;
	/** 当前模型不支持图片，图片被丢弃 */
	imagesRejected: boolean;
	/** 需要接管这次粘贴；false 时交回编辑器默认行为（纯文字粘贴） */
	handled: boolean;
}

/**
 * 一次粘贴可能同时带普通文件和图片：先统一判定，再分别落地，
 * 不能因为解析到文件路径就丢掉图片。远端会话沿用拖放的限制。
 */
export function planFilePaste(input: {
	documents: ArrayLike<unknown>;
	images: File[];
	isRemote: boolean;
	imagesSupported: boolean;
	getPathForFile: (file: unknown) => string;
}): PastePlan {
	const documents = Array.from(input.documents);
	const remoteRejected = input.isRemote && documents.length > 0;
	const paths = input.isRemote ? [] : resolveDroppedFilePaths(documents, input.getPathForFile);
	const imagesRejected = input.images.length > 0 && !input.imagesSupported;
	const images = imagesRejected ? [] : input.images;
	return {
		paths,
		images,
		remoteRejected,
		imagesRejected,
		handled: paths.length > 0 || images.length > 0 || remoteRejected || imagesRejected,
	};
}

export function fileReferencePart(path: string): Exclude<ComposerPart, { type: "text" }> {
	const label = path.split(/[\\/]/).at(-1) ?? path;
	return { type: "file", path, label: label || path };
}
