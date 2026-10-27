import { describe, expect, it } from "vitest";
import { buildSendUiError } from "./send-error";

describe("buildSendUiError — 发送路径失败信封", () => {
	it("只读会话 → sendReadOnly（session 源，无 retry）", () => {
		const err = buildSendUiError("Session is read-only", 1);
		expect(err).toMatchObject({
			severity: "error",
			source: "session",
			titleKey: "error.title.sendReadOnly",
			detail: "Session is read-only",
			actions: ["copyDetail"],
			timestamp: 1,
		});
	});

	it("auth 类拒绝 → 复用 llmAuth 判定（hint.checkApiKey）", () => {
		const err = buildSendUiError("Authentication failed for provider");
		expect(err.titleKey).toBe("error.title.llmAuth");
		expect(err.hintKey).toBe("error.hint.checkApiKey");
		expect(err.actions).toContain("retry");
	});

	it("本地普通拒绝 → sendFailed 兜底，detail 保留原文", () => {
		const err = buildSendUiError("No active session");
		expect(err.titleKey).toBe("error.title.sendFailed");
		expect(err.detail).toBe("No active session");
	});

	it("远端结果未知时提供核查提示，不提供重试动作", () => {
		const err = buildSendUiError("[PERCHO_REMOTE_OUTCOME_UNKNOWN] Remote operation outcome may be unknown");
		expect(err.titleKey).toBe("remote.unknownTitle");
		expect(err.hintKey).toBe("remote.unknownHint");
		expect(err.actions).toEqual(["copyDetail"]);
	});

	it("网络类 → llmNetwork", () => {
		const err = buildSendUiError("fetch failed: ECONNREFUSED");
		expect(err.titleKey).toBe("error.title.llmNetwork");
		expect(err.source).toBe("network");
	});
});
