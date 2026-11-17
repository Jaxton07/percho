import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSourceSnapshots } from "../src/session/source-snapshot";

let directory: string;
beforeEach(() => {
	const root = resolve("../../.local/tmp/source-snapshot-tests");
	mkdirSync(root, { recursive: true });
	directory = mkdtempSync(join(root, "run-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function fixture(id = "source", suffix = "") {
	const file = join(directory, `${id}${suffix}.jsonl`);
	const data = Buffer.from(`synthetic ${id}`).toString("base64");
	const entries = [
		{ type: "session", version: 3, id, cwd: directory, timestamp: "2026-01-01T00:00:00Z" },
		{
			type: "message",
			id: "u",
			parentId: null,
			message: {
				role: "user",
				timestamp: 1,
				content: [
					{ type: "text", text: "synthetic" },
					{ type: "image", mimeType: "image/png", data },
				],
			},
		},
		{
			type: "message",
			id: "a",
			parentId: "u",
			message: {
				role: "assistant",
				timestamp: 1,
				content: [{ type: "toolCall", name: "show_image", id: "call", arguments: {} }],
			},
		},
		{
			type: "message",
			id: "r",
			parentId: "a",
			message: {
				role: "toolResult",
				toolName: "show_image",
				toolCallId: "call",
				timestamp: 1,
				content: [],
				details: { images: [{ mimeType: "image/png", data }], paths: ["not-readable-as-path"] },
			},
		},
	];
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
	const manager = SessionManager.open(file);
	const input = {
		sessionId: id,
		file,
		branch: () => manager.getBranch(),
		entries: () => manager.getEntries(),
	};
	return { file, manager, input, data };
}

describe("原始来源快照与轻量跨GC身份", () => {
	it("GC重开后首次读取前正常追加，旧图片引用跨再次GC仍有效", () => {
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		const id = manager.appendMessage({
			role: "user",
			timestamp: 1,
			content: [{ type: "image", mimeType: "image/png", data: "AQID" }],
		});
		manager.appendMessage({ role: "assistant", timestamp: 2, content: [] } as never);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing source file");
		const sources = new SessionSourceSnapshots();
		const input = (m: SessionManager) => ({
			sessionId: m.getSessionId(),
			file,
			branch: () => m.getBranch(),
			entries: () => m.getEntries(),
			loadedFrom: m,
		});
		const owner = {};
		const first = sources.capture(owner, input(manager));
		expect(sources.resolve(owner, manager.getSessionId(), `entry:${id}:user:0`, first.version).data).toBe(
			"AQID",
		);
		sources.release(owner);
		const stamp = sources.fileVersion(file);
		const reopened = SessionManager.open(file);
		sources.noteLoaded(reopened, file, stamp);
		for (let n = 0; n < 2; n++) {
			const appended = reopened.appendMessage({ role: "user", timestamp: 3 + n, content: `追加 ${n}` });
			sources.notePersisted(reopened, file, reopened.getEntry(appended));
		}
		const middleOwner = {};
		const middle = sources.capture(middleOwner, input(reopened));
		expect(middle.version).toBe(first.version);
		sources.release(middleOwner);
		const finalStamp = sources.fileVersion(file);
		const finalManager = SessionManager.open(file);
		sources.noteLoaded(finalManager, file, finalStamp);
		const finalOwner = {};
		const final = sources.capture(finalOwner, input(finalManager));
		expect(final.version).toBe(first.version);
		expect(
			sources.resolve(finalOwner, manager.getSessionId(), `entry:${id}:user:0`, first.version).data,
		).toBe("AQID");
	});
	it.each(["none", "partial", "complete"] as const)("SDK追加失败（写入=%s）回滚后跨GC安全", (written) => {
		const f = fixture(),
			sources = new SessionSourceSnapshots(),
			owner = {};
		sources.noteLoaded(f.manager, f.file, sources.fileVersion(f.file));
		const view = sources.capture(owner, { ...f.input, loadedFrom: f.manager });
		const original = fs.appendFileSync;
		const entries = f.manager.getEntries();
		const leaf = f.manager.getLeafId();
		let failedId = "";
		const append = vi.spyOn(fs, "appendFileSync").mockImplementationOnce((path, data, options) => {
			failedId = JSON.parse(String(data)).id;
			if (written !== "none")
				original(path, written === "partial" ? String(data).slice(0, 100) : data, options);
			throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
		});
		syncBuiltinESMExports();
		try {
			expect(() =>
				f.manager.appendMessage({
					role: "toolResult",
					timestamp: 2,
					toolName: "show_image",
					toolCallId: "call",
					content: [],
					isError: false,
					details: { images: [{ data: "BAUG", mimeType: "image/png" }] },
				}),
			).toThrow("disk full");
		} finally {
			append.mockRestore();
			syncBuiltinESMExports();
		}
		expect(f.manager.getEntries()).toEqual(entries);
		expect(f.manager.getLeafId()).toBe(leaf);
		expect(f.manager.getEntry(failedId)).toBeUndefined();
		// 失败不会派发 entry_appended；随后成功写入才走真实通知路径。
		const id = f.manager.appendMessage({
			role: "user",
			timestamp: 3,
			content: [{ type: "image", mimeType: "image/png", data: "BwgJ" }],
		});
		sources.notePersisted(f.manager, f.file);
		sources.noteAppend(owner, f.manager.getEntry(id), f.manager.getEntryCount(), f.file, f.manager);
		const live = sources.capture(owner, { ...f.input, loadedFrom: f.manager });
		expect(live.shareable).toBe(written === "none");
		expect(sources.resolve(owner, "source", "entry:r:show:0", live.version).data).toBe(f.data);
		sources.release(owner);
		const beforeOpen = sources.fileVersion(f.file);
		const reopenedManager = SessionManager.open(f.file);
		sources.noteLoaded(reopenedManager, f.file, beforeOpen);
		const reopenedOwner = {};
		const reopened = sources.capture(reopenedOwner, {
			...f.input,
			branch: () => reopenedManager.getBranch(),
			entries: () => reopenedManager.getEntries(),
			loadedFrom: reopenedManager,
		});
		expect(reopened.version === view.version).toBe(written === "none");
		if (written === "none") {
			expect(sources.resolve(reopenedOwner, "source", `entry:${id}:user:0`, view.version).data).toBe("BwgJ");
		} else {
			expect(() => sources.resolve(reopenedOwner, "source", `entry:${id}:user:0`, view.version)).toThrow();
		}
		expect(reopenedManager.getEntry(failedId) !== undefined).toBe(written === "complete");
		expect(reopenedManager.getEntry(id) !== undefined).toBe(written !== "partial");
	});
	it("does not certify a large appended image with same-length corruption before its tail", () => {
		const f = fixture();
		const sources = new SessionSourceSnapshots();
		const owner = {};
		sources.noteLoaded(f.manager, f.file, sources.fileVersion(f.file));
		sources.capture(owner, { ...f.input, loadedFrom: f.manager });
		const original = fs.appendFileSync;
		const append = vi.spyOn(fs, "appendFileSync").mockImplementationOnce((path, data, options) => {
			original(path, String(data).replace('"data":"A', '"data":"B'), options);
		});
		syncBuiltinESMExports();
		let id: string;
		try {
			id = f.manager.appendMessage({
				role: "user",
				timestamp: 2,
				content: [{ type: "image", mimeType: "image/png", data: "A".repeat(128 * 1024) }],
			});
		} finally {
			append.mockRestore();
			syncBuiltinESMExports();
		}
		sources.noteAppend(owner, f.manager.getEntry(id), f.manager.getEntryCount(), f.file, f.manager);
		expect(sources.capture(owner, { ...f.input, loadedFrom: f.manager }).shareable).toBe(false);
	});

	it.each(["none", "partial", "complete"] as const)("无检视失败写入=%s", (written) => {
		const f = fixture();
		const sources = new SessionSourceSnapshots();
		sources.noteLoaded(f.manager, f.file, sources.fileVersion(f.file));
		const owner = {};
		const originalView = sources.capture(owner, { ...f.input, loadedFrom: f.manager });
		sources.release(owner);
		const original = fs.appendFileSync;
		const append = vi.spyOn(fs, "appendFileSync").mockImplementationOnce((path, data, options) => {
			if (written !== "none")
				original(path, written === "partial" ? String(data).slice(0, 100) : data, options);
			throw new Error("disk full");
		});
		syncBuiltinESMExports();
		try {
			expect(() => f.manager.appendMessage({ role: "user", timestamp: 2, content: "failed" })).toThrow();
		} finally {
			append.mockRestore();
			syncBuiltinESMExports();
		}
		const id = f.manager.appendMessage({
			role: "user",
			timestamp: 3,
			content: [{ type: "image", mimeType: "image/png", data: "BwgJ" }],
		});
		sources.notePersisted(f.manager, f.file, f.manager.getEntry(id));
		const live = sources.capture({}, { ...f.input, loadedFrom: f.manager });
		expect(live.shareable).toBe(written === "none");
		expect(sources.stats().metadata).toBe(written === "none" ? 1 : 0);
		const stamp = sources.fileVersion(f.file);
		const manager = SessionManager.open(f.file);
		sources.noteLoaded(manager, f.file, stamp);
		const newOwner = {};
		const reopened = sources.capture(newOwner, {
			...f.input,
			branch: () => manager.getBranch(),
			entries: () => manager.getEntries(),
			loadedFrom: manager,
		});
		expect(manager.getEntry(id) !== undefined).toBe(written !== "partial");
		expect(reopened.version === live.version).toBe(written === "none");
		expect(reopened.version === originalView.version).toBe(written === "none");
		if (written === "none")
			expect(sources.resolve(newOwner, "source", `entry:${id}:user:0`, live.version).data).toBe("BwgJ");
		else expect(() => sources.resolve(newOwner, "source", `entry:${id}:user:0`, live.version)).toThrow();
	});
	it("外部改写后旧SDK仍读原内存，但不把旧像素认证成GC后新文件的同版本", () => {
		const f = fixture(),
			sources = new SessionSourceSnapshots(),
			owner = {};
		sources.noteLoaded(f.manager, f.file, sources.fileVersion(f.file));
		const before = sources.capture(owner, { ...f.input, loadedFrom: f.manager });
		const replacement = Buffer.from("changed source body").toString("base64");
		writeFileSync(f.file, readFileSync(f.file, "utf8").replaceAll(f.data, replacement));
		const changed = sources.capture(owner, { ...f.input, loadedFrom: f.manager });
		expect(changed.version).not.toBe(before.version);
		expect(changed.shareable).toBe(false);
		expect(sources.resolve(owner, "source", "entry:r:show:0", changed.version).data).toBe(f.data);
		sources.capture(owner, { ...f.input, loadedFrom: f.manager });
		expect(sources.stats().metadata).toBe(0);
		sources.release(owner);
		const stamp = sources.fileVersion(f.file),
			manager = SessionManager.open(f.file);
		sources.noteLoaded(manager, f.file, stamp);
		const reopened = sources.capture(
			{},
			{
				...f.input,
				branch: () => manager.getBranch(),
				entries: () => manager.getEntries(),
				loadedFrom: manager,
			},
		);
		expect(reopened.version).not.toBe(changed.version);
		expect(reopened.shareable).toBe(true);
	});
	it("SDK加载与首次投影之间发生改写，也不能认证跨GC身份", () => {
		const f = fixture(),
			sources = new SessionSourceSnapshots(),
			owner = {};
		sources.noteLoaded(f.manager, f.file, sources.fileVersion(f.file));
		writeFileSync(f.file, readFileSync(f.file, "utf8").replaceAll(f.data, "AQIDBAUG"));
		const captured = sources.capture(owner, { ...f.input, loadedFrom: f.manager });
		expect(captured.shareable).toBe(false);
		expect(sources.stats().metadata).toBe(0);
	});
	it("新建SDK首次持久化通过受控追加保留既有版本，GC后仍可复用", () => {
		const manager = SessionManager.create(directory, join(directory, "sessions")),
			sources = new SessionSourceSnapshots(),
			owner = {};
		const input = {
			sessionId: manager.getSessionId(),
			branch: () => manager.getBranch(),
			entries: () => manager.getEntries(),
		};
		const before = sources.capture(owner, input);
		manager.appendMessage({
			role: "user",
			timestamp: 1,
			content: [{ type: "image", mimeType: "image/png", data: "AQID" }],
		});
		const id = manager.appendMessage({ role: "assistant", timestamp: 2, content: [] } as never);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing source file");
		sources.noteAppend(owner, manager.getEntry(id), manager.getEntryCount(), file);
		const captured = sources.capture(owner, { ...input, file });
		expect(captured.version).toBe(before.version);
		expect(captured.shareable).toBe(true);
		sources.release(owner);
		const reopened = sources.capture({}, { ...input, file });
		expect(reopened.version).toBe(before.version);
	});
	it("toolCallId被后续轮次复用时，活动结果不能猜配到历史同ID图片", () => {
		const f = fixture();
		const sources = new SessionSourceSnapshots();
		const owner = {};
		const view = sources.capture(owner, f.input);
		const images = [{ mimeType: "image/png", data: "BAUG" }];
		const message = {
			role: "toolResult" as const,
			timestamp: 2,
			toolCallId: "call",
			toolName: "show_image",
			content: [],
			isError: false,
			details: { images },
		};
		const pending = sources.projectTransient(view, "call", "show", images, message)[0];
		if (!pending || !("id" in pending)) throw new Error("Missing reference");
		expect(pending.id).toMatch(/^pending:/);
		expect(sources.resolve(owner, "source", pending.id, pending.revision).data).toBe("BAUG");
		const callId = f.manager.appendMessage({
			role: "assistant",
			timestamp: 2,
			content: [{ type: "toolCall", id: "call", name: "show_image", arguments: {} }],
		} as never);
		sources.noteAppend(owner, f.manager.getEntry(callId), f.manager.getEntryCount());
		const id = f.manager.appendMessage(message);
		sources.noteAppend(owner, f.manager.getEntry(id), f.manager.getEntryCount());
		const latest = sources.capture(owner, f.input);
		const persisted = sources.projectTransient(latest, "call", "show", images, message)[0];
		expect(persisted).toMatchObject({ id: `entry:${id}:show:0`, revision: view.version });
		expect(sources.resolve(owner, "source", "entry:r:show:0", view.version).data).toBe(f.data);
	});
	it("活动结果未落盘时只签发源view内的临时引用，同toolID新结果不能复用旧像素", () => {
		const source = new SessionSourceSnapshots();
		const owner = {};
		const manager = SessionManager.inMemory(directory);
		const view = source.capture(owner, {
			sessionId: "active",
			branch: () => manager.getBranch(),
			entries: () => manager.getEntries(),
		});
		const images = [{ mimeType: "image/png", data: "AQID" }];
		const first = source.projectTransient(view, "actual-tool-call", "show", images)[0];
		if (!first || !("id" in first)) throw new Error("Missing transient reference");
		expect(first.id).toMatch(/^pending:/);
		expect(source.projectTransient(view, "actual-tool-call", "show", images)[0]).toEqual(first);
		expect(source.resolve(owner, "active", first.id, first.revision).data).toBe("AQID");
		const replacement = source.projectTransient(view, "actual-tool-call", "show", [
			{ mimeType: "image/png", data: "BAUG" },
		])[0];
		expect(replacement).not.toEqual(first);
		source.release(owner);
		expect(source.stats().views).toBe(0);
		expect(() => source.resolve({}, "active", first.id, first.revision)).toThrow();
	});
	it("运行检视转为结束检视时，即使指纹未变也重新建立完整只读分支，之后只解析一次", () => {
		const f = fixture();
		const source = new SessionSourceSnapshots();
		const owner = {};
		const live = source.capture(owner, { ...f.input, branch: () => f.manager.getBranch().slice(0, 2) });
		expect(live.branch.some((entry) => entry.id === "r")).toBe(false);
		const ended = source.capture(owner, { ...f.input, readOnly: true });
		expect(ended.branch.some((entry) => entry.id === "r")).toBe(true);
		expect(ended.version).toBe(live.version);
		expect(source.stats().parses).toBe(1);
		expect(source.capture(owner, { ...f.input, readOnly: true })).toBe(ended);
	});
	it("旧用户附件超过10MiB仍可引用与预览，展示不复制正文，也不套用show_image限额", () => {
		const data = Buffer.alloc(11 * 1024 * 1024, 7).toString("base64");
		const manager = SessionManager.inMemory(directory);
		const entryId = manager.appendMessage({
			role: "user",
			timestamp: 1,
			content: [{ type: "image", mimeType: "image/png", data }],
		});
		const source = new SessionSourceSnapshots();
		const owner = {};
		const view = source.capture(owner, {
			sessionId: manager.getSessionId(),
			branch: () => manager.getBranch(),
			entries: () => manager.getEntries(),
		});
		const projected = source.project(view);
		expect(JSON.stringify(projected).length).toBeLessThan(2048);
		const loaded = source.resolve(owner, manager.getSessionId(), `entry:${entryId}:user:0`, view.version);
		expect(loaded.byteLength).toBe(11 * 1024 * 1024);
		expect(loaded.data).toBe(data);
		expect(
			(manager.getEntry(entryId) as { message: { content: { data: string }[] } }).message.content[0]?.data,
		).toBe(data);
		source.release(owner);
	});
	it("首屏不携带展示原图，按真实entry单独读取，不读paths", () => {
		const f = fixture();
		const sources = new SessionSourceSnapshots();
		const owner = {};
		const view = sources.capture(owner, f.input);
		const messages = sources.project(view);
		const shown = messages.find((message) => message.role === "image");
		expect(shown?.images[0]).toMatchObject({
			kind: "reference",
			ownerSessionId: "source",
			id: "entry:r:show:0",
			revision: view.version,
		});
		expect(shown && JSON.stringify(shown)).not.toContain(f.data);
		expect(sources.resolve(owner, "source", "entry:r:show:0", view.version)).toEqual({
			data: f.data,
			mimeType: "image/png",
			byteLength: Buffer.byteLength(f.data, "base64"),
		});
		for (const [id, revision, imageId] of [
			["other", view.version, "entry:r:show:0"],
			["source", "old", "entry:r:show:0"],
			["source", view.version, "../../secret"],
			["source", view.version, "entry:r:show:99"],
			["source", view.version, "entry:r:user:0"],
		]) {
			expect(() => sources.resolve(owner, id ?? "", imageId ?? "", revision ?? "")).toThrow();
		}
		sources.release(owner);
		expect(sources.stats().views).toBe(0);
		expect(() => sources.resolve(owner, "source", "entry:r:show:0", view.version)).toThrow();
		expect(() => sources.capture(owner, f.input)).toThrow("disposed");
	});
	it("同文件GC重开保留版本、打开实例不同；外部修改或同路径换owner使旧版本失效", () => {
		const f = fixture();
		const sources = new SessionSourceSnapshots();
		const owner = {};
		const first = sources.capture(owner, f.input);
		sources.release(owner);
		const reopened = sources.capture({}, f.input);
		expect(reopened.version).toBe(first.version);
		writeFileSync(f.file, `${readFileSync(f.file, "utf8")}\n`);
		expect(() => sources.resolve(owner, "source", "entry:r:show:0", first.version)).toThrow();
		const changed = sources.capture({}, f.input);
		expect(changed.version).not.toBe(first.version);
		const foreign = sources.capture({}, { ...f.input, sessionId: "fork" });
		expect(foreign.version).not.toBe(changed.version);
	});
	it("受控追加不为旧图另造版本，重建分支索引后可读取新增entry", () => {
		const f = fixture();
		const sources = new SessionSourceSnapshots();
		const owner = {};
		const first = sources.capture(owner, f.input);
		f.manager.appendMessage({ role: "user", timestamp: 2, content: "append" });
		sources.noteAppend(owner, f.manager.getEntry(f.manager.getLeafId() ?? ""), f.manager.getEntryCount());
		expect(sources.capture(owner, f.input).version).toBe(first.version);
		expect(sources.resolve(owner, "source", "entry:r:show:0", first.version).data).toBe(f.data);
	});
	it("结束的只读源每个文件版本只纯解析一次，多图解析不放大，内容释放后只留metadata", () => {
		const f = fixture();
		const sources = new SessionSourceSnapshots();
		const owner = {};
		const input = {
			...f.input,
			readOnly: true,
			branch: () => {
				throw new Error("must not reopen SDK");
			},
		};
		const first = sources.capture(owner, input);
		for (let i = 0; i < 63; i++) {
			expect(sources.capture(owner, input)).toBe(first);
			sources.resolve(owner, "source", "entry:r:show:0", first.version);
		}
		expect(sources.stats().parses).toBe(1);
		writeFileSync(f.file, `${readFileSync(f.file, "utf8")}\n`);
		const changed = sources.capture(owner, input);
		expect(changed.version).not.toBe(first.version);
		expect(sources.stats().parses).toBe(2);
		sources.release(owner);
		expect(sources.stats()).toMatchObject({ views: 0, metadata: 1 });
	});
	it("跨GC metadata最多128条，不保留entry或base64，LRU淘汰后产生新版本", () => {
		const sources = new SessionSourceSnapshots();
		const first = fixture("0");
		const owner = {};
		const version = sources.capture(owner, first.input).version;
		sources.release(owner);
		for (let index = 1; index <= 128; index++) {
			const f = fixture(String(index));
			const own = {};
			sources.capture(own, f.input);
			sources.release(own);
		}
		expect(sources.stats()).toMatchObject({ views: 0, metadata: 128 });
		expect(sources.capture({}, first.input).version).not.toBe(version);
		sources.dispose();
		expect(sources.stats().metadata).toBe(0);
	});
});
