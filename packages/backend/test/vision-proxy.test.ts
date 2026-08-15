import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { VisionConfig } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeImage } from "../src/vision/client";
import type { VisionConfigService } from "../src/vision/config";
import { makeVisionProxyExtension } from "../src/vision/proxy-extension";

vi.mock("../src/vision/client", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../percho/vision/client")>();
	return { ...mod, describeImage: vi.fn() };
});

const mockedDescribe = vi.mocked(describeImage);

const CONFIG: VisionConfig = {
	enabled: true,
	apiKey: "test-key",
	baseUrl: "https://open.bigmodel.cn/api/paas/v4",
	model: "glm-4.6v-flash",
};

function makeConfigService(config: VisionConfig, language: "zh" | "en" = "zh"): VisionConfigService {
	return {
		getConfig: async () => config,
		getLanguage: () => language,
	} as unknown as VisionConfigService;
}

type ContextHandler = (
	event: { type: "context"; messages: unknown[] },
	ctx: { model?: { input: string[] }; signal?: AbortSignal },
) => Promise<{ messages: unknown[] } | undefined>;

/** 构建扩展并取出 context handler（factory 闭包即会话级缓存） */
function makeHandler(
	config: VisionConfig,
	options?: { language?: "zh" | "en"; modelInput?: string[] },
): ContextHandler {
	const ext: InlineExtension = makeVisionProxyExtension({
		configService: makeConfigService(config, options?.language ?? "zh"),
	});
	let handler: ContextHandler | undefined;
	const pi = {
		on: (name: string, h: ContextHandler) => {
			if (name === "context") handler = h;
		},
	};
	ext.factory(pi as Parameters<InlineExtension["factory"]>[0]);
	if (!handler) throw new Error("context handler not registered");
	return handler;
}

const IMG_A = { type: "image", data: "aaaa", mimeType: "image/png" };
const IMG_B = { type: "image", data: "bbbb", mimeType: "image/png" };

beforeEach(() => {
	mockedDescribe.mockReset();
	mockedDescribe.mockResolvedValue("一张截图的描述");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("vision-proxy extension", () => {
	it("开关关闭时直通", async () => {
		const handler = makeHandler({ ...CONFIG, enabled: false });
		const messages = [{ role: "user", content: ["hello", IMG_A] }];
		await expect(
			handler({ type: "context", messages }, { model: { input: ["text"] } }),
		).resolves.toBeUndefined();
		expect(mockedDescribe).not.toHaveBeenCalled();
	});

	it("无 key 时直通", async () => {
		const handler = makeHandler({ ...CONFIG, apiKey: "" });
		await expect(
			handler({ type: "context", messages: [] }, { model: { input: ["text"] } }),
		).resolves.toBeUndefined();
	});

	it("原生多模态模型直通（input 含 image）", async () => {
		const handler = makeHandler(CONFIG, { modelInput: ["text", "image"] });
		const messages = [{ role: "user", content: [IMG_A] }];
		await expect(
			handler({ type: "context", messages }, { model: { input: ["text", "image"] } }),
		).resolves.toBeUndefined();
		expect(mockedDescribe).not.toHaveBeenCalled();
	});

	it("无图片时直通", async () => {
		const handler = makeHandler(CONFIG);
		const messages = [{ role: "user", content: "纯文本" }];
		await expect(
			handler({ type: "context", messages }, { model: { input: ["text"] } }),
		).resolves.toBeUndefined();
		expect(mockedDescribe).not.toHaveBeenCalled();
	});

	it("user 消息图片替换为描述文本，其余块与消息字段保留", async () => {
		const handler = makeHandler(CONFIG);
		const messages = [
			{ role: "user", content: ["看这张图", IMG_A], timestamp: 123 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		];
		const result = await handler({ type: "context", messages }, { model: { input: ["text"] } });
		expect(result).toBeDefined();
		if (!result) throw new Error("expected messages");
		const replaced = result.messages as {
			role: string;
			content: { type: string; text?: string }[];
			timestamp: number;
		}[];
		expect(replaced[0].content).toHaveLength(2);
		expect(replaced[0].content[0]).toEqual("看这张图");
		expect(replaced[0].content[1].type).toBe("text");
		expect(replaced[0].content[1].text).toBe("[[图像 1 描述]\n一张截图的描述]");
		expect(replaced[0].timestamp).toBe(123);
		// 原消息对象不被修改
		expect(messages[0].content[1].type).toBe("image");
	});

	it("toolResult 消息图片同样替换；字符串 content 不动", async () => {
		const handler = makeHandler(CONFIG);
		const messages = [
			{ role: "user", content: "读图" },
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [IMG_A, { type: "text", text: "file: x.png" }],
			},
		];
		const result = await handler({ type: "context", messages }, { model: { input: ["text"] } });
		if (!result) throw new Error("expected messages");
		const replaced = result.messages as { role: string; content: unknown }[];
		expect(replaced[0].content).toBe("读图");
		const blocks = replaced[1].content as { type: string; text?: string }[];
		expect(blocks[0].type).toBe("text");
		expect(blocks[0].text).toContain("图像 1");
		expect(blocks[1]).toEqual({ type: "text", text: "file: x.png" });
	});

	it("同图多处引用只识别一次且编号一致；不同图依次编号", async () => {
		const handler = makeHandler(CONFIG);
		const messages = [
			{ role: "user", content: [IMG_A, IMG_B] },
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [IMG_A] },
		];
		const result = await handler({ type: "context", messages }, { model: { input: ["text"] } });
		if (!result) throw new Error("expected messages");
		expect(mockedDescribe).toHaveBeenCalledTimes(2); // A + B 各一次
		const replaced = result.messages as { content: { text?: string }[] }[];
		expect(replaced[0].content[0].text).toContain("图像 1");
		expect(replaced[0].content[1].text).toContain("图像 2");
		expect(replaced[1].content[0].text).toContain("图像 1");
	});

	it("缓存：下一次 LLM 调用同图不再识别", async () => {
		const handler = makeHandler(CONFIG);
		const messages = [{ role: "user", content: [IMG_A] }];
		await handler({ type: "context", messages }, { model: { input: ["text"] } });
		await handler({ type: "context", messages }, { model: { input: ["text"] } });
		expect(mockedDescribe).toHaveBeenCalledTimes(1);
	});

	it("识别失败降级为占位文本，不中断", async () => {
		mockedDescribe.mockRejectedValueOnce(new Error("HTTP 429: rate limited"));
		const handler = makeHandler(CONFIG);
		const messages = [{ role: "user", content: [IMG_A] }];
		const result = await handler({ type: "context", messages }, { model: { input: ["text"] } });
		if (!result) throw new Error("expected messages");
		const blocks = (result.messages[0] as { content: { text?: string }[] }).content;
		expect(blocks[0].text).toBe("[[图像 1 识别失败: HTTP 429: rate limited]]");
		// 失败结果 TTL 内复用（同会话下次调用不重试）
		await handler({ type: "context", messages }, { model: { input: ["text"] } });
		expect(mockedDescribe).toHaveBeenCalledTimes(1);
	});

	it("失败结果超过 TTL 后自动重试", async () => {
		vi.useFakeTimers();
		mockedDescribe.mockRejectedValueOnce(new Error("boom"));
		const handler = makeHandler(CONFIG);
		const messages = [{ role: "user", content: [IMG_A] }];
		await handler({ type: "context", messages }, { model: { input: ["text"] } });
		expect(mockedDescribe).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(61_000);
		await handler({ type: "context", messages }, { model: { input: ["text"] } });
		expect(mockedDescribe).toHaveBeenCalledTimes(2);
	});

	it("英文界面用英文标签", async () => {
		const handler = makeHandler(CONFIG, { language: "en" });
		const messages = [{ role: "user", content: [IMG_A] }];
		const result = await handler({ type: "context", messages }, { model: { input: ["text"] } });
		if (!result) throw new Error("expected messages");
		const blocks = (result.messages[0] as { content: { text?: string }[] }).content;
		expect(blocks[0].text).toBe("[[Image 1 description]\n一张截图的描述]");
	});

	it("handler 内部异常时原样放行（不 throw）", async () => {
		const service = {
			getConfig: async () => {
				throw new Error("config read failed");
			},
			getLanguage: () => "zh" as const,
		} as unknown as VisionConfigService;
		const ext: InlineExtension = makeVisionProxyExtension({ configService: service });
		let handler: ContextHandler | undefined;
		ext.factory({
			on: (name: string, h: ContextHandler) => {
				if (name === "context") handler = h;
			},
		} as Parameters<InlineExtension["factory"]>[0]);
		const handle = handler;
		if (!handle) throw new Error("context handler not registered");
		await expect(
			handle(
				{ type: "context", messages: [{ role: "user", content: [IMG_A] }] },
				{ model: { input: ["text"] } },
			),
		).resolves.toBeUndefined();
	});
});
