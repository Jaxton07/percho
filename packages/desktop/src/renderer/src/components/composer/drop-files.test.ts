import { describe, expect, it, vi } from "vitest";
import { resolveDroppedFilePaths } from "./drop-files";

describe("resolveDroppedFilePaths", () => {
	it("resolves, de-duplicates, and skips files without a native path", () => {
		const files = [{ path: "C:\\a.txt" }, { path: "" }, { path: "C:\\a.txt" }, { path: "C:\\b.md" }];
		const getPathForFile = vi.fn((file: unknown) => (file as { path: string }).path);

		expect(resolveDroppedFilePaths(files, getPathForFile)).toEqual(["C:\\a.txt", "C:\\b.md"]);
		expect(getPathForFile).toHaveBeenCalledTimes(4);
	});

	it("preserves whitespace that is part of a native path", () => {
		const path = "/tmp/report.pdf ";

		expect(resolveDroppedFilePaths([{ path }], (file) => (file as { path: string }).path)).toEqual([path]);
	});

	it("ignores invalid drop entries instead of aborting the entire batch", () => {
		const bad = {};
		const good = {};
		const getPathForFile = vi.fn((file: unknown) => {
			if (file === bad) throw new TypeError("not a native File");
			return file === good ? "/tmp/report.pdf" : "";
		});

		expect(resolveDroppedFilePaths([bad, good], getPathForFile)).toEqual(["/tmp/report.pdf"]);
	});
});
