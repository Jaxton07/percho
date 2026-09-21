import { describe, expect, it } from "vitest";
import { toggleInList } from "./toggle-in-list";

describe("toggleInList", () => {
	it("置顶切换：新置顶排最前，取消则移除", () => {
		expect(toggleInList([], "a")).toEqual(["a"]);
		expect(toggleInList(["a"], "b")).toEqual(["b", "a"]);
		expect(toggleInList(["b", "a"], "a")).toEqual(["b"]);
	});

	it("不动原数组（纯函数：调用方拿旧引用做比较）", () => {
		const list = ["a"];
		expect(toggleInList(list, "b")).not.toBe(list);
		expect(list).toEqual(["a"]);
	});
});
