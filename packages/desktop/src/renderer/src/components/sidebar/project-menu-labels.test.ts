import { describe, expect, it } from "vitest";
import { revealLabelKey } from "./project-menu-labels";

describe("revealLabelKey", () => {
	it("macOS 用 Finder、Windows 用资源管理器、其余用文件管理器", () => {
		expect(revealLabelKey("darwin")).toBe("sidebar.revealInFinder");
		expect(revealLabelKey("win32")).toBe("sidebar.revealInExplorer");
		expect(revealLabelKey("linux")).toBe("sidebar.revealInFileManager");
		expect(revealLabelKey("freebsd")).toBe("sidebar.revealInFileManager");
	});
});
