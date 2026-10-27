import { describe, expect, it } from "vitest";
import { remoteFilePath } from "./remote-file-path";

describe("remote file copy paths", () => {
	it("preserves literal tool paths including URL-like text and line suffixes", () => {
		expect(remoteFilePath("../a%2Fb [x]:12 ", "/srv/project")).toBe("/srv/a%2Fb [x]:12 ");
		expect(remoteFilePath("/srv/not-existing%20file", "/srv/project")).toBe("/srv/not-existing%20file");
		expect(remoteFilePath("~/notes", "/srv/project")).toBe("~/notes");
	});
	it("decodes explicit Markdown file URLs only, without local filesystem access", () => {
		expect(remoteFilePath("file:///srv/a%20b%252F.txt#L12", "/srv", true)).toBe("/srv/a b%2F.txt");
		expect(() => remoteFilePath("file://other-host/a", "/srv", true)).toThrow("host");
		expect(() => remoteFilePath("a\0b", "/srv")).toThrow();
	});
});
