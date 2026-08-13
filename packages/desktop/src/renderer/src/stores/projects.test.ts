import type { SessionMeta } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { deriveProjects } from "./projects";

function session(cwd: string, modifiedAt: number): SessionMeta {
	return {
		sessionId: `${cwd}-${modifiedAt}`,
		cwd,
		name: "s",
		createdAt: modifiedAt,
		modifiedAt,
		sessionFile: "",
		active: false,
		messageCount: 0,
	};
}

describe("deriveProjects", () => {
	it("手动添加的按添加时间倒排（最新在前）", () => {
		const addedProjects = ["/a", "/b", "/c"];
		const out = deriveProjects({ allSessions: [], addedProjects });
		expect(out.map((p) => p.cwd)).toEqual(["/c", "/b", "/a"]);
		expect(out.map((p) => p.addedIndex)).toEqual([2, 1, 0]);
	});
	it("未手动添加的历史会话项目排在添加项之后，按最后活动倒序", () => {
		const addedProjects = ["/b"];
		const allSessions = [session("/a", 100), session("/c", 300), session("/b", 200)];
		const out = deriveProjects({ allSessions, addedProjects });
		expect(out.map((p) => p.cwd)).toEqual(["/b", "/c", "/a"]);
	});
	it("删除后再次添加的项目排到最新", () => {
		const out = deriveProjects({ allSessions: [], addedProjects: ["/b", "/a", "/b"] });
		expect(out.map((p) => p.cwd)).toEqual(["/b", "/a"]);
	});
	it("会话项目与添加项合并：已有条目补 addedIndex", () => {
		const addedProjects = ["/a", "/b"];
		const allSessions = [session("/a", 100), session("/c", 400)];
		const out = deriveProjects({ allSessions, addedProjects });
		expect(out.map((p) => p.cwd)).toEqual(["/b", "/a", "/c"]);
	});
});
