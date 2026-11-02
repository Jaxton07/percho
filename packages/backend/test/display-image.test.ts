import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	displayImagesFromDetails,
	isDisplayImage,
	isImageInput,
	isReferenceImage,
	messagesToUIMessages,
} from "@percho/shared";
import { describe, expect, it } from "vitest";
import { extractShowImage } from "../../shared/src/transcript/helpers";
import { sanitizeSessionMessage } from "../src/lan/sanitize";
import { toBranchSessionMessages } from "../src/session/messages";

const inline = { data: "original-base64", mimeType: "image/png" };
const reference = {
	kind: "reference" as const,
	ownerSessionId: "parent",
	id: "asset:abc",
	revision: "abc",
	mimeType: "image/png",
	byteLength: 3,
};

describe("展示图片与模型输入的边界", () => {
	it("兼容单图、多图并共用历史/实时提取器", () => {
		for (const details of [
			{ image: inline, path: "a" },
			{ images: [inline, reference], paths: ["a", "b"] },
		]) {
			expect(extractShowImage({ details })).toEqual(displayImagesFromDetails(details));
		}
		expect(isImageInput(inline)).toBe(true);
		expect(isImageInput(reference)).toBe(false);
		expect(isReferenceImage(reference)).toBe(true);
		expect(displayImagesFromDetails({ images: [null, { path: "not-an-image" }, inline] })?.images).toEqual([
			inline,
		]);
	});
	it("LAN只保留占位且去掉引用owner；提取器不透传额外字段", () => {
		const extracted = displayImagesFromDetails({
			images: [
				{ ...inline, privatePath: "secret" },
				{ ...reference, arbitrary: "secret" },
			],
		});
		expect(JSON.stringify(extracted)).not.toContain("secret");
		const sanitized = sanitizeSessionMessage({
			role: "image",
			images: [reference],
			paths: ["secret"],
			ownerSessionId: "secret-owner",
			timestamp: 1,
		});
		expect(JSON.stringify(sanitized)).not.toMatch(/asset:|secret|reference|parent|revision/);
	});
	it("非法引用不能混入模型图片或有效展示图片", () => {
		for (const value of [
			null,
			{},
			{ ...reference, revision: "" },
			{ ...reference, data: "ambiguous" },
			{ ...reference, byteLength: -1 },
			{ ...reference, byteLength: NaN },
			{ ...reference, data: "fake", ownerSessionId: "" },
		]) {
			expect(isDisplayImage(value)).toBe(false);
		}
	});
	it("真实SDK内存分叉保留图片entry，投影重绑定owner且不改变源manager", () => {
		const source = SessionManager.inMemory(process.cwd());
		const append = (message: Record<string, unknown>) =>
			source.appendMessage(message as unknown as Parameters<SessionManager["appendMessage"]>[0]);
		append({ role: "user", timestamp: 1, content: "synthetic" });
		append({
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "show", name: "show_image", arguments: {} }],
		});
		const resultId = append({
			role: "toolResult",
			timestamp: 1,
			toolCallId: "show",
			toolName: "show_image",
			content: [],
			details: { images: [reference] },
		});
		const leaf = append({ role: "assistant", timestamp: 1, content: [{ type: "text", text: "done" }] });
		const header = source.getHeader();
		if (!header) throw new Error("Missing SDK header");
		const sourceId = source.getSessionId();
		const before = JSON.stringify([header, ...source.getEntries()]);
		const fork = SessionManager.inMemory(
			process.cwd(),
			undefined,
			structuredClone([header, ...source.getEntries()]),
		);
		fork.createBranchedSession(leaf);
		expect(fork.getSessionId()).not.toBe(sourceId);
		expect(source.getSessionId()).toBe(sourceId);
		expect(JSON.stringify([source.getHeader(), ...source.getEntries()])).toBe(before);
		const images = toBranchSessionMessages(fork.getBranch(), fork.getSessionId()).filter(
			(m) => m.role === "image",
		);
		expect(images[0]?.entryId).toBe(resultId);
		expect(images[0]?.ownerSessionId).toBe(fork.getSessionId());
		expect(images[0]?.images).toEqual([{ ...reference, ownerSessionId: fork.getSessionId() }]);
	});
	it("同时间戳、多结果按真实entry定位；fork的owner覆盖持久化父owner", () => {
		const entry = (id: string, message: unknown) =>
			({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message }) as SessionEntry;
		const branch = [
			entry("call", {
				role: "assistant",
				timestamp: 1,
				content: [
					{ type: "toolCall", id: "a", name: "show_image", arguments: {} },
					{ type: "toolCall", id: "b", name: "show_image", arguments: {} },
				],
			}),
			entry("result-a", { role: "toolResult", toolCallId: "a", timestamp: 1, details: { image: inline } }),
			entry("result-b", {
				role: "toolResult",
				toolCallId: "b",
				timestamp: 1,
				details: { images: [reference] },
			}),
		];
		const before = JSON.stringify(branch);
		const images = toBranchSessionMessages(branch, "fork").filter((m) => m.role === "image");
		expect(images.map((m) => m.entryId)).toEqual(["result-a", "result-b"]);
		expect(images.map((m) => m.ownerSessionId)).toEqual(["fork", "fork"]);
		expect(images[1]?.images).toEqual([{ ...reference, ownerSessionId: "fork" }]);
		expect(
			messagesToUIMessages(images).map((m) => (m.kind === "image" ? [m.entryId, m.ownerSessionId] : null)),
		).toEqual([
			["result-a", "fork"],
			["result-b", "fork"],
		]);
		expect(JSON.stringify(branch)).toBe(before);
	});
});
