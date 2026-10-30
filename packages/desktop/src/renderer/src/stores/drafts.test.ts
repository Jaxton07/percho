import {
	composerDocumentFromText,
	composerDocumentText,
	parseComposerDocument,
	readComposerDocument,
} from "@percho/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
	draftText,
	EMPTY_DRAFT,
	restoreFailedDraft,
	restoreRejectedDraft,
	takeDraft,
	useDraftStore,
	withDraftText,
} from "./drafts";

beforeEach(() =>
	useDraftStore.setState({ bySession: {}, failedBySession: {}, pendingBySession: {}, errorsBySession: {} }),
);

describe("输入快照与失败恢复", () => {
	it("未知版本历史保守显示占位而不暴露展开定义，发送解析仍严格拒绝", () => {
		const raw = { perchoInput: { version: 99, parts: [] }, content: "PRIVATE_DEFINITION" };
		expect(readComposerDocument(raw)).toEqual(composerDocumentFromText("[Unsupported composer input]"));
		expect(() => parseComposerDocument(raw.perchoInput)).toThrow();
	});

	it("未知的 file kind 只丢图标，不把整条消息变成占位符", () => {
		const raw = {
			perchoInput: { version: 1, parts: [{ type: "file", path: "/tmp/a.md", kind: "symlink" }] },
			content: "PRIVATE_DEFINITION",
		};
		expect(readComposerDocument(raw)?.parts).toEqual([{ type: "file", path: "/tmp/a.md" }]);
		expect(parseComposerDocument(raw.perchoInput).parts).toEqual([{ type: "file", path: "/tmp/a.md" }]);
	});

	it("发送期间的新编辑不被拒绝结果覆盖，可交换恢复两份内容", () => {
		useDraftStore.getState().updateDraft("a", (d) => withDraftText(d, "发送前"));
		const sent = takeDraft("a");
		useDraftStore.getState().updateDraft("a", (d) => withDraftText(d, "等待期间新写的"));
		restoreRejectedDraft("a", sent);
		expect(draftText(useDraftStore.getState().bySession.a ?? EMPTY_DRAFT)).toBe("等待期间新写的");
		restoreFailedDraft("a");
		expect(draftText(useDraftStore.getState().bySession.a ?? EMPTY_DRAFT)).toBe("发送前");
		expect(draftText(useDraftStore.getState().failedBySession.a ?? EMPTY_DRAFT)).toBe("等待期间新写的");
	});
	it("目标未再编辑时完整恢复附件和原输入，不影响其他会话", () => {
		useDraftStore.getState().updateDraft("a", (d) => ({
			...withDraftText(d, "内容"),
			quotes: ["引用"],
			slashCommand: "skill:test",
		}));
		useDraftStore.getState().updateDraft("b", (d) => withDraftText(d, "另一份"));
		const sent = takeDraft("a");
		restoreRejectedDraft("a", sent);
		expect(useDraftStore.getState().bySession.a).toEqual(sent);
		expect(draftText(useDraftStore.getState().bySession.b ?? EMPTY_DRAFT)).toBe("另一份");
	});
	it("新草稿代次已变化时，即使空白也不自动回填旧失败输入", () => {
		useDraftStore.getState().updateDraft("new", (d) => withDraftText(d, "旧目标"));
		const sent = takeDraft("new");
		restoreRejectedDraft("new", sent, true);
		expect(useDraftStore.getState().bySession.new).toBeUndefined();
		expect(useDraftStore.getState().failedBySession.new).toEqual(sent);
	});
	it("中立文档往返保留空白、换行和资源身份，并拒绝未知结构", () => {
		const source = {
			version: 1,
			parts: [
				{ type: "text", text: " 前文\n" },
				{ type: "skill", id: "one", label: "test" },
				{ type: "text", text: " 后文 " },
			],
		};
		const parsed = parseComposerDocument(JSON.parse(JSON.stringify(source)));
		expect(parsed).toEqual(source);
		expect(composerDocumentText(composerDocumentFromText(" \n\n "))).toBe(" \n\n ");
		expect(() => parseComposerDocument({ version: 2, parts: [] })).toThrow();
	});
});
