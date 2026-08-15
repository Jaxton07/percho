import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toSessionMessages } from "../src/session/messages";
import { makeShowImageTool, resolveShowImagePath } from "../src/tools/show-image";

const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function executeShowImage(params: { paths: string[] }, cwd: string) {
	const tool = makeShowImageTool();
	// execute 只用 ctx.cwd，其余字段测试不需要
	return tool.execute("tc1", params, undefined, undefined, { cwd } as never);
}

describe("resolveShowImagePath", () => {
	it("~ 与 ~/ 展开为 home", () => {
		expect(resolveShowImagePath("~", "/cwd", "/home/u")).toBe("/home/u");
		expect(resolveShowImagePath("~/Downloads/pic.png", "/cwd", "/home/u")).toBe("/home/u/Downloads/pic.png");
	});

	it("相对路径按 cwd resolve；绝对路径原样", () => {
		expect(resolveShowImagePath("a/b.png", "/cwd", "/home/u")).toBe("/cwd/a/b.png");
		expect(resolveShowImagePath("/abs/c.png", "/cwd", "/home/u")).toBe("/abs/c.png");
	});

	it("unicode 空格归一（macOS 截图窄空格）", () => {
		expect(resolveShowImagePath("~/截图/claude\u202Fusage.png", "/cwd", "/home/u")).toBe(
			"/home/u/截图/claude usage.png",
		);
	});
});

describe("show_image 工具", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "show-image-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("读取图片：content 只给文本，图片走 details（不进模型上下文）", async () => {
		await writeFile(join(dir, "logo.png"), PNG_BYTES);
		const result = await executeShowImage({ paths: ["logo.png"] }, dir);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("logo.png") }]);
		expect(result.details).toEqual({
			paths: ["logo.png"],
			images: [{ data: PNG_BYTES.toString("base64"), mimeType: "image/png" }],
		});
	});

	it("多图一次调用：全部进 details.images，文本带数量", async () => {
		await writeFile(join(dir, "a.png"), PNG_BYTES);
		await writeFile(join(dir, "b.jpg"), PNG_BYTES);
		await writeFile(join(dir, "c.webp"), PNG_BYTES);
		const result = await executeShowImage({ paths: ["a.png", "b.jpg", "c.webp"] }, dir);
		expect(result.details?.paths).toEqual(["a.png", "b.jpg", "c.webp"]);
		expect(result.details?.images.map((img) => img.mimeType)).toEqual([
			"image/png",
			"image/jpeg",
			"image/webp",
		]);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("3 images") });
	});

	it("绝对路径与大小写扩展名", async () => {
		const file = join(dir, "PHOTO.JPEG");
		await writeFile(file, PNG_BYTES);
		const result = await executeShowImage({ paths: [file] }, dir);
		expect(result.details?.images[0]?.mimeType).toBe("image/jpeg");
	});

	it("不支持的扩展名报错", async () => {
		await writeFile(join(dir, "notes.txt"), "hello");
		await expect(executeShowImage({ paths: ["notes.txt"] }, dir)).rejects.toThrow("unsupported image type");
	});

	it("文件不存在报错", async () => {
		await expect(executeShowImage({ paths: ["missing.png"] }, dir)).rejects.toThrow("file not found");
	});
});

describe("toSessionMessages：show_image 历史回放", () => {
	it("show_image 的 toolResult.details 产出独立图片消息，紧随 assistant 之后", () => {
		const messages = toSessionMessages([
			{ role: "user", content: [{ type: "text", text: "给我看看 logo" }], timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "好的" },
					{ type: "toolCall", id: "tc1", name: "show_image", arguments: { paths: ["logo.png"] } },
				],
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				content: [{ type: "text", text: "Image displayed to the user in the chat: logo.png" }],
				details: { paths: ["logo.png"], images: [{ data: "AAAA", mimeType: "image/png" }] },
				isError: false,
				timestamp: 3,
			},
			{ role: "assistant", content: [{ type: "text", text: "就是这张" }], timestamp: 4 },
		]);
		// 同 turn 正文→工具拆分：正文消息在前，无正文工具组紧随，image 消息跟在工具组后
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "image", "assistant"]);
		expect(messages[3]).toMatchObject({
			role: "image",
			images: [{ data: "AAAA", mimeType: "image/png" }],
			paths: ["logo.png"],
		});
		// 工具卡在无正文工具组消息上，照常回填文本输出
		const toolGroup = messages[2];
		if (toolGroup?.role !== "assistant") throw new Error("expected assistant tool group");
		expect(toolGroup.tools[0]).toMatchObject({
			name: "show_image",
			output: expect.stringContaining("logo.png"),
		});
		// 正文消息不携带工具
		const bodyText = messages[1];
		if (bodyText?.role !== "assistant") throw new Error("expected assistant body");
		expect(bodyText.text).toContain("好的");
		expect(bodyText.tools).toHaveLength(0);
	});

	it("多图 details 完整还原为一条图片消息", () => {
		const messages = toSessionMessages([
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc1", name: "show_image", arguments: { paths: ["a.png", "b.png"] } },
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				content: [{ type: "text", text: "2 images displayed" }],
				details: {
					paths: ["a.png", "b.png"],
					images: [
						{ data: "AAAA", mimeType: "image/png" },
						{ data: "BBBB", mimeType: "image/png" },
					],
				},
				isError: false,
				timestamp: 2,
			},
		]);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			role: "image",
			images: [
				{ data: "AAAA", mimeType: "image/png" },
				{ data: "BBBB", mimeType: "image/png" },
			],
		});
	});

	it("兼容旧单图 details { path, image } 形状", () => {
		const messages = toSessionMessages([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "show_image", arguments: { path: "old.png" } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				content: [{ type: "text", text: "Image displayed" }],
				details: { path: "old.png", image: { data: "CCCC", mimeType: "image/png" } },
				isError: false,
				timestamp: 2,
			},
		]);
		expect(messages[1]).toMatchObject({
			role: "image",
			images: [{ data: "CCCC", mimeType: "image/png" }],
			paths: ["old.png"],
		});
	});

	it("其他工具的 details 不产生图片消息；show_image 出错也不产生", () => {
		const messages = toSessionMessages([
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc1", name: "webfetch", arguments: { url: "https://x" } },
					{ type: "toolCall", id: "tc2", name: "show_image", arguments: { paths: ["a.png"] } },
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				content: [{ type: "text", text: "page" }],
				details: { url: "https://x", status: 200 },
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "tc2",
				content: [{ type: "text", text: "show_image: file not found" }],
				isError: true,
				timestamp: 3,
			},
		]);
		expect(messages.map((m) => m.role)).toEqual(["assistant"]);
	});
});
