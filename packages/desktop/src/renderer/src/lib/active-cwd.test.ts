import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { type ActiveCwdState, selectActiveCwd } from "./active-cwd";

const base: ActiveCwdState = {
	activeSessionId: null,
	sessions: [{ sessionId: "known", cwd: "/meta" }],
	newSessionDraft: { cwd: "/draft" },
	cwd: "/compat",
};
describe("current directory is pure and preserves null/unknown compatibility", () => {
	it.each([
		[{ ...base }, "/draft"],
		[{ ...base, newSessionDraft: { cwd: null } }, null],
		[{ ...base, newSessionDraft: null }, null],
		[{ ...base, activeSessionId: "known" }, "/meta"],
		[{ ...base, activeSessionId: "known", sessions: [{ sessionId: "known", cwd: "" }] }, ""],
		[{ ...base, activeSessionId: "unknown" }, "/compat"],
		[{ ...base, activeSessionId: "unknown", cwd: null }, null],
	] as const)("selects from authoritative input without repairing/mutating it", (state, expected) => {
		const before = structuredClone(state);
		expect(selectActiveCwd(state)).toBe(expected);
		expect(state).toEqual(before);
	});
	it("leaf has no imports; foreground host readers import the actual selector", () => {
		const leaf = ts.createSourceFile(
			"active-cwd.ts",
			readFileSync(new URL("./active-cwd.ts", import.meta.url), "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		expect(leaf.statements.filter(ts.isImportDeclaration)).toEqual([]);
		for (const file of [
			"sidebar/Sidebar",
			"session/SessionTabBar",
			"composer/Composer",
			"session/ProjectBranchPicker",
			"diff/DiffSidebar",
			"chat/TurnDiffChip",
			"settings/mcp/McpPanel",
		]) {
			const text = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8");
			const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
			expect(
				parsed.statements
					.filter(ts.isImportDeclaration)
					.some((item) => (item.moduleSpecifier as ts.StringLiteral).text.endsWith("/active-cwd")),
			).toBe(true);
			expect(text).not.toMatch(/useSessionsStore\(\(s\) => s\.cwd/);
		}
	});
});
