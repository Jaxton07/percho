import { describe, expect, it, vi } from "vitest";
import { fileReferencePart, planFilePaste } from "./paste-files";

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
