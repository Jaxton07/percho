import type { SessionMeta } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { buildDiagnosticsText } from "./diagnostics";

const session: Pick<SessionMeta, "sessionId" | "sessionFile" | "name"> = {
	sessionId: "01a03e43-dde8-7634-ac82-1b2bfadb6580",
	sessionFile: "/Users/ericw/.pi/agent/sessions/--proj--/2026-08-26T13-30-30-248Z_01a03e43.jsonl",
	name: "统一报错系统",
};

describe("buildDiagnosticsText", () => {
	it("包含全部定位字段，traceFile 按 sessionFile 同目录推导", () => {
		const text = buildDiagnosticsText(session, { platform: "darwin", appVersion: "0.5.3" });
		expect(text).toContain("sessionId: 01a03e43-dde8-7634-ac82-1b2bfadb6580");
		expect(text).toContain("name: 统一报错系统");
		expect(text).toContain(
			"sessionFile: /Users/ericw/.pi/agent/sessions/--proj--/2026-08-26T13-30-30-248Z_01a03e43.jsonl",
		);
		expect(text).toContain(
			"traceFile: /Users/ericw/.pi/agent/sessions/--proj--/traces/trace-01a03e43-dde8-7634-ac82-1b2bfadb6580.jsonl",
		);
		expect(text).toContain("appVersion: 0.5.3");
		expect(text).toContain("platform: darwin");
	});

	it("内存会话（无 sessionFile）：两处都标注，不编造路径", () => {
		const text = buildDiagnosticsText(
			{ sessionId: "draft-1", sessionFile: undefined, name: undefined },
			{ platform: "darwin", appVersion: "0.5.3" },
		);
		expect(text).toContain("sessionFile: (内存会话)");
		expect(text).toContain("traceFile: (内存会话)");
		expect(text).toContain("name: (未命名)");
	});
});
