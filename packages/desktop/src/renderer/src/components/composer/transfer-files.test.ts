import { describe, expect, it, vi } from "vitest";
import { readTransferItems, resolveTransferPaths, type TransferItemLike } from "./transfer-files";

function item(file: { path?: string; type?: string } | null, directory?: boolean): TransferItemLike {
	const value = file ? ({ type: "", ...file } as unknown as File) : null;
	return {
		kind: "file",
		getAsFile: () => value,
		webkitGetAsEntry: () => (directory === undefined ? null : { isDirectory: directory }),
	};
}

const pathOf = (file: unknown) => (file as { path: string }).path;

describe("readTransferItems", () => {
	it("splits files and images and marks directories from the entry", () => {
		const { files, images } = readTransferItems([
			item({ path: "/tmp/README.md", type: "text/markdown" }, false),
			item({ path: "/tmp/docs" }, true),
			item({ path: "/tmp/pic.png", type: "image/png" }, false),
			{ kind: "string", getAsFile: () => null },
			item(null),
		]);

		expect(
			files.map((entry) => ({
				path: (entry.file as unknown as { path: string }).path,
				directory: entry.directory,
			})),
		).toEqual([
			{ path: "/tmp/README.md", directory: false },
			{ path: "/tmp/docs", directory: true },
			{ path: "/tmp/pic.png", directory: false },
		]);
		expect(images.map((file) => (file as unknown as { path: string }).path)).toEqual(["/tmp/pic.png"]);
	});

	it("treats a missing or failing entry as a plain file", () => {
		const failing: TransferItemLike = {
			kind: "file",
			getAsFile: () => ({ path: "/tmp/dir", type: "" }) as unknown as File,
			webkitGetAsEntry: () => {
				throw new TypeError("no entry");
			},
		};

		const { files } = readTransferItems([item({ path: "/tmp/dir" }), failing]);

		expect(files.map((entry) => entry.directory)).toEqual([false, false]);
	});
});

describe("resolveTransferPaths", () => {
	it("resolves, de-duplicates, and skips files without a native path", () => {
		const files = [
			{ file: { path: "C:\\a.txt" } as unknown as File, directory: false },
			{ file: {} as unknown as File, directory: false },
			{ file: { path: "C:\\a.txt" } as unknown as File, directory: false },
			{ file: { path: "C:\\docs" } as unknown as File, directory: true },
		];
		const getPathForFile = vi.fn(pathOf);

		expect(resolveTransferPaths(files, getPathForFile)).toEqual([
			{ path: "C:\\a.txt", kind: "file" },
			{ path: "C:\\docs", kind: "directory" },
		]);
		expect(getPathForFile).toHaveBeenCalledTimes(4);
	});

	it("preserves whitespace that is part of a native path", () => {
		const path = "/tmp/report.pdf ";
		const files = [{ file: { path } as unknown as File, directory: false }];

		expect(resolveTransferPaths(files, pathOf)).toEqual([{ path, kind: "file" }]);
	});

	it("ignores entries whose path lookup throws instead of aborting the batch", () => {
		const bad = {} as unknown as File;
		const good = { path: "/tmp/report.pdf" } as unknown as File;
		const getPathForFile = vi.fn((file: unknown) => {
			if (file === bad) throw new TypeError("not a native File");
			return (file as { path?: string }).path ?? "";
		});

		expect(
			resolveTransferPaths(
				[
					{ file: bad, directory: false },
					{ file: good, directory: false },
				],
				getPathForFile,
			),
		).toEqual([{ path: "/tmp/report.pdf", kind: "file" }]);
	});
});
