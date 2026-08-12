import { describe, expect, it } from "vitest";
import { formatTodoList, makeTodoTool, normalizeTodos } from "../src/todo-tool";

describe("normalizeTodos", () => {
	it("多 in_progress：保留第一个、其余降 pending", () => {
		expect(
			normalizeTodos([
				{ content: "a", status: "in_progress" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "pending" },
			]),
		).toEqual([
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "pending" },
			{ content: "c", status: "pending" },
		]);
	});

	it("空 content 过滤（含纯空白）", () => {
		expect(
			normalizeTodos([
				{ content: "  ", status: "pending" },
				{ content: "", status: "completed" },
				{ content: "ok", status: "pending" },
			]),
		).toEqual([{ content: "ok", status: "pending" }]);
	});

	it("上限 50 条截断", () => {
		const raw = Array.from({ length: 60 }, (_, i) => ({ content: `t${i}`, status: "pending" as const }));
		expect(normalizeTodos(raw)).toHaveLength(50);
	});

	it("空数组保持空（清空语义）", () => {
		expect(normalizeTodos([])).toEqual([]);
	});
});

describe("formatTodoList", () => {
	it("编号 + 状态标记文本", () => {
		expect(
			formatTodoList([
				{ content: "重构", status: "in_progress" },
				{ content: "测试", status: "completed" },
			]),
		).toBe("1. [in_progress] 重构\n2. [completed] 测试");
	});
});

describe("makeTodoTool execute", () => {
	it("content 为文本清单、details 为规整后的 todos", async () => {
		const tool = makeTodoTool();
		const result = await tool.execute(
			"c1",
			{
				todos: [
					{ content: "重构", status: "in_progress" },
					{ content: "测试", status: "pending" },
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details).toEqual({
			todos: [
				{ content: "重构", status: "in_progress" },
				{ content: "测试", status: "pending" },
			],
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Current task list:\n1. [in_progress] 重构\n2. [pending] 测试",
		});
	});

	it("空数组：content 提示已清空、details 空列表", async () => {
		const tool = makeTodoTool();
		const result = await tool.execute("c1", { todos: [] }, undefined, undefined, undefined as never);
		expect(result.content[0]).toMatchObject({ type: "text", text: "Todo list cleared (empty)." });
		expect(result.details).toEqual({ todos: [] });
	});
});
