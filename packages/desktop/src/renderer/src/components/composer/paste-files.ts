import type { ComposerPart } from "@percho/shared";
import { resolveDroppedFilePaths } from "./drop-files";

type ReferencePart = Exclude<ComposerPart, { type: "text" }>;
type InsertRange = { start: number; end: number };

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

export function fileReferencePart(path: string): ReferencePart {
	const label = path.split(/[\\/]/).at(-1) ?? path;
	return { type: "file", path, label: label || path };
}

/** 目录与文件共用同一种引用，只靠 kind 决定图标；类型缺失时按文件展示。 */
export function fileReferenceParts(
	paths: string[],
	kinds?: ReadonlyArray<"file" | "directory">,
): ReferencePart[] {
	return paths.map((path, index) => {
		const part = fileReferencePart(path);
		return kinds?.[index] === "directory" ? { ...part, kind: "directory" as const } : part;
	});
}

export interface FilePasteTargets {
	/** 粘贴当刻的选区；必须在异步查路径类型前同步读取 */
	selectionRange: () => InsertRange;
	insertReferences: (references: ReferencePart[], range: InsertRange) => void;
	addImages: (files: File[]) => void;
	pathKinds: (paths: string[]) => Promise<Array<"file" | "directory">>;
	toast: (message: "remote.localFileRejected" | "composer.imageUnsupported") => void;
}

/**
 * 把判定结果落到界面。引用和图片各自独立落地：谁都不允许提前结束，
 * 否则同一次粘贴里另一半内容会被静默丢掉。
 */
export function commitFilePaste(plan: PastePlan, targets: FilePasteTargets): void {
	if (plan.remoteRejected) targets.toast("remote.localFileRejected");
	if (plan.imagesRejected) targets.toast("composer.imageUnsupported");
	if (plan.paths.length > 0) {
		// 先记下选区：类型要问主进程，回来时用户可能已经挪了光标。
		const range = targets.selectionRange();
		const insert = (kinds?: Array<"file" | "directory">) =>
			targets.insertReferences(fileReferenceParts(plan.paths, kinds), range);
		void targets.pathKinds(plan.paths).then(insert, () => insert());
	}
	if (plan.images.length > 0) targets.addImages(plan.images);
}
