import type { ComposerPart } from "@percho/shared";
import {
	type NativeFileRef,
	readTransferItems,
	resolveTransferPaths,
	type TransferItemLike,
} from "./drop-files";

type ReferencePart = Exclude<ComposerPart, { type: "text" }>;
type InsertRange = { start: number; end: number };

export interface PastePlan {
	/** 已在光标处落成文件引用的原生路径（目录带 kind，用来选图标） */
	refs: NativeFileRef[];
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
 * 目录身份直接取自 FileSystemEntry，全程同步，不需要再问主进程。
 */
export function planFilePaste(input: {
	items: ArrayLike<TransferItemLike>;
	isRemote: boolean;
	imagesSupported: boolean;
	getPathForFile: (file: unknown) => string;
}): PastePlan {
	const { files, images } = readTransferItems(input.items);
	const documents = files.filter((entry) => !entry.file.type.startsWith("image/"));
	const remoteRejected = input.isRemote && documents.length > 0;
	// 远端不解析本机路径（连读取都不做），普通文件因此整体丢弃。
	const refs = input.isRemote ? [] : resolveTransferPaths(documents, input.getPathForFile);
	const imagesRejected = images.length > 0 && !input.imagesSupported;
	const keptImages = imagesRejected ? [] : images;
	return {
		refs,
		images: keptImages,
		remoteRejected,
		imagesRejected,
		handled: refs.length > 0 || keptImages.length > 0 || remoteRejected || imagesRejected,
	};
}

export function fileReferencePart(path: string): ReferencePart {
	const label = path.split(/[\\/]/).at(-1) ?? path;
	return { type: "file", path, label: label || path };
}

/** 目录与文件共用同一种引用，只靠 kind 决定图标；没有目录标记时按文件展示。 */
export function fileReferenceParts(refs: ReadonlyArray<NativeFileRef>): ReferencePart[] {
	return refs.map(({ path, kind }) => {
		const part = fileReferencePart(path);
		return kind === "directory" ? { ...part, kind: "directory" as const } : part;
	});
}

export interface FilePasteTargets {
	/** 粘贴当刻的选区 */
	selectionRange: () => InsertRange;
	insertReferences: (references: ReferencePart[], range: InsertRange) => void;
	addImages: (files: File[]) => void;
	toast: (message: "remote.localFileRejected" | "composer.imageUnsupported") => void;
}

/**
 * 把判定结果落到界面。引用和图片各自独立落地：谁都不允许提前结束，
 * 否则同一次粘贴里另一半内容会被静默丢掉。
 */
export function commitFilePaste(plan: PastePlan, targets: FilePasteTargets): void {
	if (plan.remoteRejected) targets.toast("remote.localFileRejected");
	if (plan.imagesRejected) targets.toast("composer.imageUnsupported");
	if (plan.refs.length > 0) {
		// 同步读取：编辑器仍然是粘贴事件发生时的光标/选区。
		targets.insertReferences(fileReferenceParts(plan.refs), targets.selectionRange());
	}
	if (plan.images.length > 0) targets.addImages(plan.images);
}
