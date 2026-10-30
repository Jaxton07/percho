import { describe, expect, it, vi } from "vitest";
import { commitFilePaste, fileReferencePart, fileReferenceParts, planFilePaste } from "./paste-files";

const pathOf = (file: unknown) => (file as { path: string }).path;

describe("planFilePaste", () => {
	it("puts local file references and images in one paste", () => {
		const markdown = { path: "/tmp/README.md" };
		const image = { type: "image/png" } as unknown as File;

		const plan = planFilePaste({
			documents: [markdown],
			images: [image],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});

		expect(plan.paths).toEqual(["/tmp/README.md"]);
		expect(plan.images).toEqual([image]);
		expect(plan.remoteRejected).toBe(false);
		expect(plan.imagesRejected).toBe(false);
		expect(plan.handled).toBe(true);
	});

	it("rejects local files in a remote session and keeps images", () => {
		const image = { type: "image/png" } as unknown as File;
		const getPathForFile = vi.fn(pathOf);

		const plan = planFilePaste({
			documents: [{ path: "/tmp/README.md" }],
			images: [image],
			isRemote: true,
			imagesSupported: true,
			getPathForFile,
		});

		expect(plan.paths).toEqual([]);
		expect(plan.images).toEqual([image]);
		expect(plan.remoteRejected).toBe(true);
		expect(plan.handled).toBe(true);
		// 远端不需要本机路径，连解析都不必做
		expect(getPathForFile).not.toHaveBeenCalled();
	});

	it("keeps file references but drops images when the model is text only", () => {
		const plan = planFilePaste({
			documents: [{ path: "/tmp/README.md" }],
			images: [{ type: "image/png" } as unknown as File],
			isRemote: false,
			imagesSupported: false,
			getPathForFile: pathOf,
		});

		expect(plan.paths).toEqual(["/tmp/README.md"]);
		expect(plan.images).toEqual([]);
		expect(plan.imagesRejected).toBe(true);
		expect(plan.remoteRejected).toBe(false);
		expect(plan.handled).toBe(true);
	});

	it("leaves plain text paste to the editor", () => {
		const plan = planFilePaste({
			documents: [],
			images: [],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});

		expect(plan).toEqual({
			paths: [],
			images: [],
			remoteRejected: false,
			imagesRejected: false,
			handled: false,
		});
	});

	it("still warns about images in a remote session without touching local files", () => {
		const plan = planFilePaste({
			documents: [{ path: "/tmp/README.md" }],
			images: [{ type: "image/png" } as unknown as File],
			isRemote: true,
			imagesSupported: false,
			getPathForFile: pathOf,
		});

		expect(plan.paths).toEqual([]);
		expect(plan.images).toEqual([]);
		expect(plan.remoteRejected).toBe(true);
		expect(plan.imagesRejected).toBe(true);
		expect(plan.handled).toBe(true);
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
		expect(fileReferenceParts(["/tmp/docs", "/tmp/README.md"], ["directory", "file"])).toEqual([
			{ type: "file", path: "/tmp/docs", label: "docs", kind: "directory" },
			{ type: "file", path: "/tmp/README.md", label: "README.md" },
		]);
	});

	it("falls back to file when the kind lookup has no answer", () => {
		expect(fileReferenceParts(["/tmp/docs"])).toEqual([{ type: "file", path: "/tmp/docs", label: "docs" }]);
		expect(fileReferenceParts(["/tmp/docs"], [])).toEqual([
			{ type: "file", path: "/tmp/docs", label: "docs" },
		]);
	});
});

function pasteTargets() {
	const calls: string[] = [];
	return {
		calls,
		selectionRange: vi.fn(() => {
			calls.push("range");
			return { start: 2, end: 2 };
		}),
		insertReferences: vi.fn(),
		addImages: vi.fn(),
		pathKinds: vi.fn(async (_paths: string[]): Promise<Array<"file" | "directory">> => {
			calls.push("kinds");
			return ["file"];
		}),
		toast: vi.fn(),
	};
}

describe("commitFilePaste", () => {
	it("lands references and images from one paste", async () => {
		const image = { type: "image/png" } as unknown as File;
		const plan = planFilePaste({
			documents: [{ path: "/tmp/README.md" }],
			images: [image],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});
		const targets = pasteTargets();

		commitFilePaste(plan, targets);

		// 图片不等路径类型，判定为接管后立刻加入图片托盘
		expect(targets.addImages).toHaveBeenCalledWith([image]);
		// 选区在发起异步查询前同步记下
		expect(targets.calls).toEqual(["range", "kinds"]);
		expect(targets.toast).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(targets.insertReferences).toHaveBeenCalledWith(
				[{ type: "file", path: "/tmp/README.md", label: "README.md" }],
				{ start: 2, end: 2 },
			),
		);
	});

	it("keeps references and images when the kind lookup fails", async () => {
		const image = { type: "image/png" } as unknown as File;
		const plan = planFilePaste({
			documents: [{ path: "/tmp/README.md" }],
			images: [image],
			isRemote: false,
			imagesSupported: true,
			getPathForFile: pathOf,
		});
		const targets = {
			...pasteTargets(),
			pathKinds: vi.fn(async () => {
				throw new Error("path kinds unavailable");
			}),
		};

		commitFilePaste(plan, targets);

		await vi.waitFor(() =>
			expect(targets.insertReferences).toHaveBeenCalledWith(
				[{ type: "file", path: "/tmp/README.md", label: "README.md" }],
				{ start: 2, end: 2 },
			),
		);
		expect(targets.addImages).toHaveBeenCalledWith([image]);
	});

	it("keeps images of a remote paste and never resolves local paths", () => {
		const image = { type: "image/png" } as unknown as File;
		const plan = planFilePaste({
			documents: [{ path: "/tmp/README.md" }],
			images: [image],
			isRemote: true,
			imagesSupported: true,
			getPathForFile: pathOf,
		});
		const targets = pasteTargets();

		commitFilePaste(plan, targets);

		expect(targets.toast).toHaveBeenCalledWith("remote.localFileRejected");
		expect(targets.addImages).toHaveBeenCalledWith([image]);
		expect(targets.selectionRange).not.toHaveBeenCalled();
		expect(targets.pathKinds).not.toHaveBeenCalled();
		expect(targets.insertReferences).not.toHaveBeenCalled();
	});
});
