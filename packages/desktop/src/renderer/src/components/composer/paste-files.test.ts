import { describe, expect, it, vi } from "vitest";
import { commitFilePaste, fileReferencePart, fileReferenceParts, planFilePaste } from "./paste-files";
import type { TransferItemLike } from "./transfer-files";

const pathOf = (file: unknown) => (file as { path: string }).path;

function fileItem(
	path: string,
	options: { type?: string; directory?: boolean; entry?: boolean } = {},
): TransferItemLike {
	const file = { path, type: options.type ?? "" } as unknown as File;
	return {
		kind: "file",
		getAsFile: () => file,
		...(options.entry === false
			? {}
			: { webkitGetAsEntry: () => ({ isDirectory: options.directory === true }) }),
	};
}

const textItem: TransferItemLike = { kind: "string", getAsFile: () => null };

describe("planFilePaste", () => {
	it("puts file references, directory markers, and images in one paste", () => {
		const plan = planFilePaste({
			items: [
				fileItem("/tmp/README.md"),
				fileItem("/tmp/docs", { directory: true }),
				fileItem("/tmp/pic.png", { type: "image/png" }),
				textItem,
			],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});

		expect(plan.refs).toEqual([
			{ path: "/tmp/README.md", kind: "file" },
			{ path: "/tmp/docs", kind: "directory" },
		]);
		expect(plan.images.map((file) => (file as unknown as { path: string }).path)).toEqual(["/tmp/pic.png"]);
		expect(plan.remoteRejected).toBe(false);
		expect(plan.imagesRejected).toBe(false);
		expect(plan.handled).toBe(true);
	});

	it("rejects local files in a remote session and keeps images", () => {
		const getPathForFile = vi.fn(pathOf);

		const plan = planFilePaste({
			items: [fileItem("/tmp/README.md"), fileItem("/tmp/pic.png", { type: "image/png" })],
			isRemote: true,
			imagesSupported: true,
			getPathForFile,
		});

		expect(plan.refs).toEqual([]);
		expect(plan.images).toHaveLength(1);
		expect(plan.remoteRejected).toBe(true);
		expect(plan.handled).toBe(true);
		// 远端不需要本机路径，连解析都不必做
		expect(getPathForFile).not.toHaveBeenCalled();
	});

	it("keeps file references but drops images when the model is text only", () => {
		const plan = planFilePaste({
			items: [fileItem("/tmp/README.md"), fileItem("/tmp/pic.png", { type: "image/png" })],
			isRemote: false,
			imagesSupported: false,
			getPathForFile: pathOf,
		});

		expect(plan.refs).toEqual([{ path: "/tmp/README.md", kind: "file" }]);
		expect(plan.images).toEqual([]);
		expect(plan.imagesRejected).toBe(true);
		expect(plan.remoteRejected).toBe(false);
		expect(plan.handled).toBe(true);
	});

	it("leaves plain text paste to the editor", () => {
		const plan = planFilePaste({
			items: [textItem],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});

		expect(plan).toEqual({
			refs: [],
			images: [],
			remoteRejected: false,
			imagesRejected: false,
			filesRejected: false,
			handled: false,
		});
	});

	it("still warns about images in a remote session without touching local files", () => {
		const plan = planFilePaste({
			items: [fileItem("/tmp/README.md"), fileItem("/tmp/pic.png", { type: "image/png" })],
			isRemote: true,
			imagesSupported: false,
			getPathForFile: pathOf,
		});

		expect(plan.refs).toEqual([]);
		expect(plan.images).toEqual([]);
		expect(plan.remoteRejected).toBe(true);
		expect(plan.imagesRejected).toBe(true);
		expect(plan.handled).toBe(true);
	});

	it("asks the user to copy again when the file has no native path", () => {
		const plan = planFilePaste({
			items: [fileItem("/tmp/README.md")],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: () => "",
		});

		expect(plan.refs).toEqual([]);
		expect(plan.filesRejected).toBe(true);
		expect(plan.handled).toBe(true);
	});

	it("keeps silent when every file resolves", () => {
		const plan = planFilePaste({
			items: [fileItem("/tmp/README.md")],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});

		expect(plan.filesRejected).toBe(false);
	});

	it("falls back to a file reference when the entry cannot report a directory", () => {
		const plan = planFilePaste({
			items: [fileItem("/tmp/docs", { entry: false })],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});

		expect(plan.refs).toEqual([{ path: "/tmp/docs", kind: "file" }]);
	});
});

describe("fileReferencePart", () => {
	it("keeps the full path and shows only the file name", () => {
		expect(fileReferencePart("/Users/me/docs/report.pdf")).toEqual({
			type: "file",
			path: "/Users/me/docs/report.pdf",
			label: "report.pdf",
		});
		expect(fileReferencePart("C:\\work\\note.md")).toEqual({
			type: "file",
			path: "C:\\work\\note.md",
			label: "note.md",
		});
	});

	it("falls back to the path when it ends with a separator", () => {
		expect(fileReferencePart("/tmp/dir/")).toEqual({ type: "file", path: "/tmp/dir/", label: "/tmp/dir/" });
	});
});

describe("fileReferenceParts", () => {
	it("marks directories so the chip can use a folder icon", () => {
		expect(
			fileReferenceParts([
				{ path: "/tmp/docs", kind: "directory" },
				{ path: "/tmp/README.md", kind: "file" },
			]),
		).toEqual([
			{ type: "file", path: "/tmp/docs", label: "docs", kind: "directory" },
			{ type: "file", path: "/tmp/README.md", label: "README.md" },
		]);
	});
});

function pasteTargets() {
	return {
		selectionRange: vi.fn(() => ({ start: 2, end: 2 })),
		insertReferences: vi.fn(),
		addImages: vi.fn(),
		toast: vi.fn(),
	};
}

describe("commitFilePaste", () => {
	it("lands references and images from one paste", () => {
		const plan = planFilePaste({
			items: [
				fileItem("/tmp/README.md"),
				fileItem("/tmp/docs", { directory: true }),
				fileItem("/tmp/pic.png", { type: "image/png" }),
			],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});
		const targets = pasteTargets();

		commitFilePaste(plan, targets);

		// 同步落地：粘贴事件里完成，不需要等任何 IPC
		expect(targets.insertReferences).toHaveBeenCalledWith(
			[
				{ type: "file", path: "/tmp/README.md", label: "README.md" },
				{ type: "file", path: "/tmp/docs", label: "docs", kind: "directory" },
			],
			{ start: 2, end: 2 },
		);
		expect(targets.addImages).toHaveBeenCalledWith(plan.images);
		expect(targets.toast).not.toHaveBeenCalled();
	});

	it("reports files whose path cannot be read", () => {
		const plan = planFilePaste({
			items: [fileItem("/tmp/README.md")],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: () => "",
		});
		const targets = pasteTargets();

		commitFilePaste(plan, targets);

		expect(targets.toast).toHaveBeenCalledWith("composer.filePathUnavailable");
		expect(targets.insertReferences).not.toHaveBeenCalled();
	});

	it("keeps images of a remote paste and never resolves local paths", () => {
		const plan = planFilePaste({
			items: [fileItem("/tmp/README.md"), fileItem("/tmp/pic.png", { type: "image/png" })],
			isRemote: true,
			imagesSupported: true,
			getPathForFile: pathOf,
		});
		const targets = pasteTargets();

		commitFilePaste(plan, targets);

		expect(targets.toast).toHaveBeenCalledWith("remote.localFileRejected");
		expect(targets.addImages).toHaveBeenCalledWith(plan.images);
		expect(targets.insertReferences).not.toHaveBeenCalled();
	});
});
