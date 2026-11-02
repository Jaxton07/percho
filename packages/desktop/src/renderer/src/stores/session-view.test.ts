import { beforeEach, expect, it } from "vitest";
import { useSessionViewStore as views } from "./session-view";
import { useTranscriptStore as transcripts } from "./transcript";

beforeEach(() => {
	views.setState({ bySession: {} });
	transcripts.setState({ bySession: {} });
});
it("驻留会话互不串用；关闭后迟到写入不能复活状态，重开为默认", () => {
	for (const id of ["local:a", "ssh:host:a"]) transcripts.getState().loadHistory(id, []);
	views.getState().setDetail("local:a", "file:a", true);
	views.getState().setScope("local:a", "latest");
	expect(views.getState().bySession["ssh:host:a"]?.scope).toBe("all");
	transcripts.getState().resetSession("local:a");
	views.getState().setDetail("local:a", "file:a", true);
	views.getState().setAnchor("local:a", { key: "file:a", offset: 10, scrollTop: 100 });
	expect(views.getState().bySession["local:a"]).toBeUndefined();
	transcripts.getState().loadHistory("local:a", []);
	expect(views.getState().bySession["local:a"]).toEqual({ scope: "all", details: {} });
});
it("替换基线时只剔除失效来源，不留下错误锚点", () => {
	views.getState().ensure("a");
	views.getState().setDetail("a", "kept", true);
	views.getState().setDetail("a", "gone", true);
	views.getState().setAnchor("a", { key: "gone", offset: 1, scrollTop: 1 });
	views.getState().prune("a", new Set(["kept"]));
	expect(views.getState().bySession.a).toEqual({ scope: "all", details: { kept: true }, anchor: undefined });
});
