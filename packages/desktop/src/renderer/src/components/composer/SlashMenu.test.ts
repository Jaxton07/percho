import type { SlashCommandInfo } from "@pi-desktop/shared";
import { describe, expect, it } from "vitest";
import { filterCommands } from "./slash-filter";

function cmd(name: string, source: SlashCommandInfo["source"]): SlashCommandInfo {
	return { name, description: "", source, supported: true };
}

describe("filterCommands", () => {
	const commands: SlashCommandInfo[] = [
		cmd("compact", "builtin"),
		cmd("rename", "builtin"),
		cmd("skill:mindmap", "skill"),
		cmd("skill:research", "skill"),
		cmd("help", "extension"),
	];

	it("空 query 返回全部且顺序不变", () => {
		expect(filterCommands(commands, "")).toEqual(commands);
	});
	it("非 skill 命令维持前缀匹配，不误伤 skill", () => {
		expect(filterCommands(commands, "comp")).toEqual([cmd("compact", "builtin")]);
		expect(filterCommands(commands, "hel")).toEqual([cmd("help", "extension")]);
		expect(filterCommands(commands, "compact")).toEqual([cmd("compact", "builtin")]);
	});
	it("skill: 前缀可命中", () => {
		expect(filterCommands(commands, "skill:m")).toEqual([cmd("skill:mindmap", "skill")]);
	});
	it("去前缀后前缀命中 skill", () => {
		expect(filterCommands(commands, "mind")).toEqual([cmd("skill:mindmap", "skill")]);
		expect(filterCommands(commands, "mindmap")).toEqual([cmd("skill:mindmap", "skill")]);
	});
	it("去前缀后子串命中（前缀命中在前，子串在后）", () => {
		expect(filterCommands(commands, "indmap")).toEqual([cmd("skill:mindmap", "skill")]);
		const more: SlashCommandInfo[] = [cmd("skill:game-map", "skill"), cmd("skill:mindmap", "skill")];
		expect(filterCommands(more, "map")).toEqual([
			cmd("skill:game-map", "skill"),
			cmd("skill:mindmap", "skill"),
		]);
		expect(filterCommands(more, "m")).toEqual([
			cmd("skill:mindmap", "skill"),
			cmd("skill:game-map", "skill"),
		]);
	});
	it("无匹配返回空", () => {
		expect(filterCommands(commands, "zzzz")).toEqual([]);
	});
});
