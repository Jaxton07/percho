/**
 * 剪贴板与拖放共用：沙箱里 File 只有 name 没有原生路径，路径必须由 preload 的
 * webUtils 还原；目录身份只能从 FileSystemEntry 读到（目录在两侧都表现为 type 为空的
 * file item，getAsFile 不携带这个信息，而 stat 要么再开一条 IPC、要么把插入变成异步）。
 */

/** DataTransferItem 的可用子集：粘贴和拖放都提供它，测试可直接造对象。 */
export interface TransferItemLike {
	kind: string;
	getAsFile: () => File | null;
	webkitGetAsEntry?: () => { isDirectory: boolean } | null;
}

export interface TransferFile {
	file: File;
	/** 目录只能从 FileSystemEntry 判定；拿不到 entry 时按普通文件算 */
	directory: boolean;
}

export interface TransferFiles {
	/** 本次传输里的所有文件（图片也在内，顺序与条目一致） */
	files: TransferFile[];
	/** 其中走图片管线的那些（同一批 File 对象） */
	images: File[];
}

/** 一次遍历分出文件（带目录标记）与图片；不解析路径，远端会话也能安全调用。 */
export function readTransferItems(items: ArrayLike<TransferItemLike>): TransferFiles {
	const files: TransferFile[] = [];
	const images: File[] = [];
	for (const item of Array.from(items)) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (!file) continue;
		files.push({ file, directory: isDirectory(item) });
		if (file.type.startsWith("image/")) images.push(file);
	}
	return { files, images };
}

function isDirectory(item: TransferItemLike): boolean {
	try {
		return item.webkitGetAsEntry?.()?.isDirectory === true;
	} catch {
		// entry 读取失败按文件算：图标保守，不影响引用和发送。
		return false;
	}
}

export interface NativeFileRef {
	path: string;
	kind: "file" | "directory";
}

/** 原生路径 + 目录标记；去重、跳过拿不到原生路径的条目（JS 造的 File、非本机项）。 */
export function resolveTransferPaths(
	files: ReadonlyArray<TransferFile>,
	getPathForFile: (file: unknown) => string,
): NativeFileRef[] {
	const refs: NativeFileRef[] = [];
	const seen = new Set<string>();
	for (const { file, directory } of files) {
		let path = "";
		try {
			path = getPathForFile(file);
		} catch {
			// 不是原生 File：忽略这一条，不打断整批粘贴/拖放。
			continue;
		}
		if (!path || seen.has(path)) continue;
		seen.add(path);
		refs.push({ path, kind: directory ? "directory" : "file" });
	}
	return refs;
}
