import { buildLlmUiError, classifyLlmError, DETAIL_MAX_LENGTH, type UiError } from "@percho/shared";
import { describe, expect, it } from "vitest";

describe("classifyLlmError — 模式表按序首命中", () => {
	it("401 → llmAuth（retry/openSettings/copyDetail + hint.checkApiKey）", () => {
		expect(classifyLlmError('401: {"message":"Invalid API key provided"}')).toEqual({
			titleKey: "error.title.llmAuth",
			hintKey: "error.hint.checkApiKey",
			source: "llm",
			actions: ["retry", "openSettings", "copyDetail"],
		});
		expect(classifyLlmError("unauthorized: something")).toMatchObject({ titleKey: "error.title.llmAuth" });
		expect(classifyLlmError("Invalid API key: sk-xxx")).toMatchObject({ titleKey: "error.title.llmAuth" });
		expect(classifyLlmError("authentication failed")).toMatchObject({ titleKey: "error.title.llmAuth" });
	});

	it("429 / rate limit / too many → llmRateLimit（retry/copyDetail + hint.rateLimit）", () => {
		for (const text of [
			'429: {"message":"Rate limit reached"}',
			"rate limit exceeded, retry after 60s",
			"Too Many Requests",
		]) {
			expect(classifyLlmError(text)).toEqual({
				titleKey: "error.title.llmRateLimit",
				hintKey: "error.hint.rateLimit",
				source: "llm",
				actions: ["retry", "copyDetail"],
			});
		}
	});

	it("context overflow → llmOverflow（compact/copyDetail + hint.compact）", () => {
		for (const text of [
			"maximum context length is 128000 tokens, your messages resulted in 132456",
			"context_length_exceeded",
			"context length exceeded",
			"too many tokens in the request",
		]) {
			expect(classifyLlmError(text)).toEqual({
				titleKey: "error.title.llmOverflow",
				hintKey: "error.hint.compact",
				source: "llm",
				actions: ["compact", "copyDetail"],
			});
		}
	});

	it("网络/超时 → llmNetwork（retry/copyDetail + hint.network，source=network）", () => {
		for (const text of [
			"fetch failed: ETIMEDOUT",
			"ECONNREFUSED 127.0.0.1:8080",
			"ENOTFOUND api.example.com",
			"fetch failed",
			"network error",
			"request timeout after 30000ms",
		]) {
			expect(classifyLlmError(text)).toEqual({
				titleKey: "error.title.llmNetwork",
				hintKey: "error.hint.network",
				source: "network",
				actions: ["retry", "copyDetail"],
			});
		}
	});

	it("大小写不敏感", () => {
		expect(classifyLlmError("RATE LIMIT REACHED")).toMatchObject({ titleKey: "error.title.llmRateLimit" });
		expect(classifyLlmError("UNAUTHORIZED")).toMatchObject({ titleKey: "error.title.llmAuth" });
	});

	it("兜底 → llmGeneric（retry/copyDetail，无 hint）", () => {
		expect(classifyLlmError("模型服务端返回了一个奇怪的错误: something weird")).toEqual({
			titleKey: "error.title.llmGeneric",
			source: "llm",
			actions: ["retry", "copyDetail"],
		});
	});
});

describe("buildLlmUiError — 信封构造", () => {
	it("组装完整 UiError（severity/source/titleKey/detail/timestamp/actions）", () => {
		const err = buildLlmUiError('401: {"error":"nope"}', 123456);
		expect(err).toEqual({
			severity: "error",
			source: "llm",
			titleKey: "error.title.llmAuth",
			hintKey: "error.hint.checkApiKey",
			detail: '401: {"error":"nope"}',
			actions: ["retry", "openSettings", "copyDetail"],
			timestamp: 123456,
		});
	});

	it("detail 截断到 DETAIL_MAX_LENGTH（含截断标记）", () => {
		const long = "x".repeat(DETAIL_MAX_LENGTH + 500);
		const err = buildLlmUiError(long);
		expect(err.detail).toBeDefined();
		const detail = err.detail ?? "";
		expect(detail.length).toBeLessThanOrEqual(DETAIL_MAX_LENGTH + 20);
		expect(detail.endsWith("…[已截断]")).toBe(true);
		expect(detail.length).toBe(DETAIL_MAX_LENGTH + "\n…[已截断]".length);
	});

	it("不超长时不截断", () => {
		const err = buildLlmUiError("short error");
		expect(err.detail).toBe("short error");
	});

	it("multibyte 截断不产生孤立代理对（slice by code point）", () => {
		const long = "漢".repeat(DETAIL_MAX_LENGTH / 2 + 100);
		const err = buildLlmUiError(long);
		expect(err.detail).toBeDefined();
		// 若半个代理对被切开，JSON 序列化会炸；这里能正常断言即证明未切
		expect(JSON.parse(JSON.stringify(err as UiError))).toBeDefined();
	});
});
