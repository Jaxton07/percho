import type { VisionConfig } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeImage, pingVision, VisionClientError } from "../src/vision/client";

const CONFIG: VisionConfig = {
	enabled: true,
	apiKey: "test-key",
	baseUrl: "https://open.bigmodel.cn/api/paas/v4",
	model: "glm-4.6v-flash",
};

const fetchMock = vi.fn();

function okResponse(content: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function lastBody(): Record<string, unknown> {
	const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1] as RequestInit;
	return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("vision client", () => {
	it("智谱端点：URL 拼接 + Bearer 鉴权 + thinking 关闭", async () => {
		fetchMock.mockResolvedValueOnce(okResponse("描述"));
		const result = await describeImage(
			{ config: CONFIG, language: "zh" },
			{ data: "abc", mimeType: "image/png" },
		);
		expect(result).toBe("描述");
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
		expect(lastBody().thinking).toEqual({ type: "disabled" });
		expect(lastBody().enable_thinking).toBeUndefined();
		// 图走 data URL，识别 prompt 跟随语言
		const content = (lastBody().messages as { content: unknown[] }[])[0].content as {
			type: string;
			image_url?: { url: string };
			text?: string;
		}[];
		expect(content[0].image_url?.url).toBe("data:image/png;base64,abc");
		expect(content[1].text).toContain("视觉识别代理");
	});

	it("DashScope 端点：enable_thinking=false，不带智谱 thinking 字段", async () => {
		fetchMock.mockResolvedValueOnce(okResponse("desc"));
		await describeImage(
			{
				config: {
					...CONFIG,
					baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
					model: "qwen3.7-flash",
				},
				language: "en",
			},
			{ data: "abc", mimeType: "image/png" },
		);
		const [url] = fetchMock.mock.calls[0] as [string, unknown];
		// 尾斜杠归一，不出现 //chat
		expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
		expect(lastBody().enable_thinking).toBe(false);
		expect(lastBody().thinking).toBeUndefined();
		expect((lastBody().messages as { content: unknown[] }[])[0].content).toBeDefined();
	});

	it("其他 OpenAI 兼容端点：两个思考字段都不带", async () => {
		fetchMock.mockResolvedValueOnce(okResponse("ok"));
		await describeImage(
			{ config: { ...CONFIG, baseUrl: "https://api.example.com/v1" }, language: "zh" },
			{ data: "abc", mimeType: "image/png" },
		);
		expect(lastBody().thinking).toBeUndefined();
		expect(lastBody().enable_thinking).toBeUndefined();
	});

	it("非 2xx：解析 error.message 并带 status", async () => {
		fetchMock.mockImplementation(
			async () =>
				new Response(JSON.stringify({ error: { message: "该模型当前访问量过大" } }), { status: 429 }),
		);
		await expect(
			describeImage({ config: CONFIG, language: "zh" }, { data: "abc", mimeType: "image/png" }),
		).rejects.toThrow(VisionClientError);
		await expect(
			describeImage({ config: CONFIG, language: "zh" }, { data: "abc", mimeType: "image/png" }),
		).rejects.toThrow("HTTP 429: 该模型当前访问量过大");
	});

	it("空响应内容抛错", async () => {
		fetchMock.mockResolvedValueOnce(okResponse("  "));
		await expect(
			describeImage({ config: CONFIG, language: "zh" }, { data: "abc", mimeType: "image/png" }),
		).rejects.toThrow("empty content");
	});

	it("无 key 直接抛错（不发请求）", async () => {
		await expect(
			describeImage(
				{ config: { ...CONFIG, apiKey: "" }, language: "zh" },
				{ data: "abc", mimeType: "image/png" },
			),
		).rejects.toThrow("API key not configured");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("ping 用 16×16 png（Qwen3.7-VL 要求宽高 >10px）+ 短 prompt，max_tokens 受限，且带 host 思考开关", async () => {
		fetchMock.mockResolvedValueOnce(okResponse("OK"));
		const result = await pingVision({ config: CONFIG, language: "zh" });
		expect(result).toBe("OK");
		expect(lastBody().max_tokens).toBe(16);
		expect(lastBody().thinking).toEqual({ type: "disabled" });
		const content = (lastBody().messages as { content: unknown[] }[])[0].content as {
			image_url?: { url: string };
		}[];
		// 16×16：IHDR 宽高字段为 0x10 0x10（AAAB 不是旧的 AAAB…见 base64 头 0x10,0x10）
		expect(content[0].image_url?.url).toContain("data:image/png;base64,iVBOR");
		// 解码验证尺寸 16×16
		const b64 = content[0].image_url?.url.split(",")[1] ?? "";
		const ihdr = Buffer.from(b64, "base64").subarray(16, 24);
		const width = ihdr.readUInt32BE(0);
		const height = ihdr.readUInt32BE(4);
		expect(width).toBe(16);
		expect(height).toBe(16);
	});

	it("ping DashScope 端点带 enable_thinking=false（非流式 + 默认开思考会报错）", async () => {
		fetchMock.mockResolvedValueOnce(okResponse("OK"));
		await pingVision({
			config: {
				...CONFIG,
				baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				model: "qwen3.7-flash",
			},
			language: "zh",
		});
		expect(lastBody().enable_thinking).toBe(false);
		expect(lastBody().thinking).toBeUndefined();
	});
});
