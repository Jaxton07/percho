import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { JsonStore } from "../src/json-store";
import {
	readSessionHeaderId,
	type SessionArchiveOptions,
	SessionArchiveService,
} from "../src/session/archive";
import type { SessionCatalog } from "../src/session/catalog";

const base = resolve("../../.local/tmp/session-archive-catalog/final-authority/fixtures");
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "archive-"));
	roots.push(root);
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	manager.appendCustomEntry("channel-subs", { topics: ["news"], cursors: {} });
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing test session file");
	const id = manager.getSessionId();
	let busy = false;
	let failCleanup = false;
	let failIndex = false;
	const catalog = {
		verify: async () => [{ status: "present", meta: { sessionId: id, sessionFile: file } }],
		setArchive: async () => {
			if (failIndex) throw new Error("index unavailable");
		},
	} as unknown as SessionCatalog;
	const options: SessionArchiveOptions = {
		agentDir: root,
		catalog: () => catalog,
		getSession: () => undefined,
		hasPending: () => busy,
		disposeSession: async () => {
			if (failCleanup) throw new Error("dispose failed");
		},
		withFile: async (_files, operation) => operation(),
	};
	const service = new SessionArchiveService(options);
	await service.init();
	return {
		root,
		file,
		id,
		service,
		options,
		input: { sessionId: id, sessionFile: file, expectedRevision: 0 },
		setBusy: (v: boolean) => {
			busy = v;
		},
		setCleanup: (v: boolean) => {
			failCleanup = v;
		},
		setIndex: (v: boolean) => {
			failIndex = v;
		},
	};
}

it("persists unsubscribe, supports idempotency and rejects stale opposite operations", async () => {
	const f = await fixture();
	const result = await f.service.archive(f.input);
	expect(result).toMatchObject({ archived: true, revision: 1 });
	const entries = SessionManager.open(f.file).getEntries();
	expect(entries.at(-1)).toMatchObject({
		type: "custom",
		customType: "channel-subs",
		data: { topics: [], cursors: {}, archiveOp: expect.any(String) },
	});
	expect(await f.service.archive(f.input)).toMatchObject({ revision: 1 });
	await expect(f.service.assertOpen(f.file)).rejects.toThrow();
	await expect(f.service.unarchive(f.input)).rejects.toThrow(/conflict/);
	expect(await f.service.unarchive({ ...f.input, expectedRevision: 1 })).toMatchObject({
		archived: false,
		revision: 2,
	});
	await expect(f.service.archive(f.input)).rejects.toThrow(/conflict/);
	await f.service.assertOpen(f.file);
});

it("rejects pending work, invalid tails and absent conversation without modifying files", async () => {
	const f = await fixture();
	f.setBusy(true);
	await expect(f.service.archive(f.input)).rejects.toThrow(/busy/);
	f.setBusy(false);
	const original = await readFile(f.file, "utf8");
	await writeFile(f.file, `${original}{"type":`);
	await expect(f.service.archive(f.input)).rejects.toThrow(/tail/);
	expect(await readFile(f.file, "utf8")).toBe(`${original}{"type":`);
	const header = original.split("\n")[0] ?? "";
	await writeFile(f.file, `${header}\n`);
	await expect(f.service.archive(f.input)).rejects.toThrow(/conversation/);
});

it("accepts a complete non-newline tail and legacy broken middle lines", async () => {
	const f = await fixture();
	const lines = (await readFile(f.file, "utf8")).trimEnd().split("\n");
	lines.splice(1, 0, "broken old line");
	await writeFile(f.file, lines.join("\n"));
	expect(await f.service.archive(f.input)).toMatchObject({ archived: true });
});

it("recovers matching prepared intent and blocks insufficient evidence", async () => {
	const f = await fixture();
	await f.service.archive(f.input);
	const path = join(f.root, "session-archive.json");
	const data = JSON.parse(await readFile(path, "utf8"));
	data.records[0].phase = "prepared";
	await writeFile(path, JSON.stringify(data));
	const restarted = new SessionArchiveService(f.options);
	await restarted.init();
	expect(await restarted.state(f.id, f.file)).toMatchObject({ phase: "archived-cleanup", blocked: true });
	data.records[0].opId = "not-matching";
	await writeFile(path, JSON.stringify(data));
	const blocked = new SessionArchiveService(f.options);
	await blocked.init();
	expect(await blocked.state(f.id, f.file)).toMatchObject({ phase: "prepared", blocked: true });
	await expect(blocked.assertOpen(f.file)).rejects.toThrow();
});

it("keeps authoritative state across index failures and allows actual cleanup retry", async () => {
	const f = await fixture();
	f.setCleanup(true);
	f.setIndex(true);
	expect(await f.service.archive(f.input)).toMatchObject({ archived: true, cleanupPending: true });
	await expect(f.service.retryCleanup(f.id, f.file)).rejects.toThrow(/cleanup/);
	expect(await f.service.projections()).toMatchObject([{ path: f.file, archiveCleanupPending: true }]);
	f.setCleanup(false);
	await f.service.retryCleanup(f.id, f.file);
	expect(await f.service.state(f.id, f.file)).toMatchObject({ archived: true, phase: "archived" });
	const restarted = new SessionArchiveService(f.options);
	await restarted.init();
	await expect(restarted.assertOpen(f.file)).rejects.toThrow();
});

it("completes disposal and reports archived when the catalog mirror fails", async () => {
	const f = await fixture();
	f.setIndex(true);
	const dispose = vi.fn(async () => {});
	const service = new SessionArchiveService({ ...f.options, disposeSession: dispose });
	await service.init();
	expect(await service.archive(f.input)).toMatchObject({ archived: true, revision: 1 });
	expect((await service.state(f.id, f.file)).cleanupPending).toBeUndefined();
	expect(dispose).toHaveBeenCalledOnce();
	expect(JSON.parse(await readFile(join(f.root, "session-archive.json"), "utf8")).records[0].phase).toBe(
		"archived",
	);
	await expect(service.assertOpen(f.file)).rejects.toThrow();
	expect(SessionManager.open(f.file).getEntries().at(-1)).toMatchObject({
		customType: "channel-subs",
		data: { topics: [], cursors: {} },
	});
});

it("retries a failed archive commit without restarting or appending unsubscribe twice", async () => {
	const f = await fixture();
	const write = JsonStore.prototype.write;
	let fail = true;
	const spy = vi.spyOn(JsonStore.prototype, "write").mockImplementation(async function (value) {
		if (fail && (value as { records?: { phase: string }[] })?.records?.[0]?.phase === "archived-cleanup") {
			fail = false;
			throw new Error("commit write unavailable");
		}
		await write.call(this, value);
	});
	try {
		await expect(f.service.archive(f.input)).rejects.toThrow(/commit write unavailable/);
		const before = await readFile(f.file, "utf8");
		expect(JSON.parse(await readFile(join(f.root, "session-archive.json"), "utf8")).records[0].phase).toBe(
			"prepared",
		);
		const pending = f.service.peek(f.id, f.file);
		expect(pending).toMatchObject({ phase: "prepared", blocked: true, archived: false, revision: 0 });
		expect(pending?.archivedAt).toBeUndefined();
		expect(await f.service.archive({ ...f.input, expectedRevision: pending!.revision })).toMatchObject({
			archived: true,
			revision: 1,
		});
		expect(await readFile(f.file, "utf8")).toBe(before);
		await expect(f.service.assertOpen(f.file)).rejects.toThrow(/archived/);
	} finally {
		spy.mockRestore();
	}
});

it("retries a failed unsubscribe with the original prepared operation only when absence is provable", async () => {
	const f = await fixture();
	const originalOpen = SessionManager.open.bind(SessionManager);
	const spy = vi.spyOn(SessionManager, "open").mockImplementationOnce(() => {
		throw new Error("append unavailable");
	});
	try {
		await expect(f.service.archive(f.input)).rejects.toThrow(/append unavailable/);
		const prepared = JSON.parse(await readFile(join(f.root, "session-archive.json"), "utf8")).records[0];
		f.setBusy(true);
		await expect(f.service.archive(f.input)).rejects.toThrow(/busy/);
		f.setBusy(false);
		await f.service.archive(f.input);
		expect(originalOpen(f.file).getEntries().at(-1)).toMatchObject({ data: { archiveOp: prepared.opId } });
	} finally {
		spy.mockRestore();
	}
});

it("rejects copies with the same identity and preserves missing-file errors", async () => {
	const f = await fixture();
	await f.service.archive(f.input);
	const copy = join(f.root, "copy.jsonl");
	await copyFile(f.file, copy);
	await expect(f.service.assertOpen(copy)).rejects.toThrow(/identity/);
	await expect(f.service.assertOpen(join(f.root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains a real SDK lease after cleanup failure until disposal succeeds", async () => {
	const f = await fixture();
	const model: Model<"openai-completions"> = {
		id: "test",
		name: "test",
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		input: ["text"],
		reasoning: false,
		contextWindow: 128000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	let api!: ExtensionAPI;
	const errors: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd: f.root,
		agentDir: f.root,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	await loader.reload();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(f.root, "auth-test"),
		modelsPath: null,
		modelsStorePath: join(f.root, "models-test"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "test",
		models: [model],
	});
	const { session } = await createAgentSession({
		cwd: f.root,
		agentDir: f.root,
		model,
		settingsManager,
		resourceLoader: loader,
		noTools: "all",
		sessionManager: SessionManager.open(f.file),
		modelRuntime,
	});
	session.agent.streamFunction = async () => {
		const stream = createAssistantMessageEventStream();
		stream.push({
			type: "done",
			reason: "stop",
			message: {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				stopReason: "stop",
				content: [{ type: "text", text: "done" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
		return stream;
	};
	await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.event) });
	let fail = true;
	const service = new SessionArchiveService({
		...f.options,
		getSession: () => session,
		disposeSession: async () => {
			if (fail) throw new Error("failed");
			session.dispose();
		},
	});
	try {
		await service.init();
		const before = await readFile(f.file, "utf8");
		const lease = session.tryAcquireIdleLease();
		expect(lease).toBeDefined();
		try {
			await expect(service.archive(f.input)).rejects.toThrow(/busy/);
			expect(await readFile(f.file, "utf8")).toBe(before);
		} finally {
			lease?.release();
		}
		const write = JsonStore.prototype.write;
		const spy = vi.spyOn(JsonStore.prototype, "write").mockImplementationOnce(async function (value) {
			await write.call(this, value);
			throw new Error("directory sync uncertain");
		});
		try {
			await expect(service.archive(f.input)).rejects.toThrow(/directory sync uncertain/);
		} finally {
			spy.mockRestore();
		}
		expect(JSON.parse(await readFile(join(f.root, "session-archive.json"), "utf8")).records[0].phase).toBe(
			"prepared",
		);
		api.sendUserMessage("uncertain late");
		api.sendMessage({ customType: "late", content: "uncertain late", display: true });
		await vi.waitFor(() => expect(errors.sort()).toEqual(["send_message", "send_user_message"]));
		expect(session.tryAcquireIdleLease()).toBeUndefined();
		errors.length = 0;
		const commitSpy = vi.spyOn(JsonStore.prototype, "write").mockImplementation(async function (value) {
			await write.call(this, value);
			if ((value as { records?: { phase: string }[] })?.records?.[0]?.phase === "archived-cleanup")
				throw new Error("commit sync uncertain");
		});
		try {
			await expect(service.archive(f.input)).rejects.toThrow(/commit sync uncertain/);
		} finally {
			commitSpy.mockRestore();
		}
		api.sendUserMessage("commit uncertain late");
		api.sendMessage({ customType: "late", content: "commit uncertain late", display: true });
		await vi.waitFor(() => expect(errors.sort()).toEqual(["send_message", "send_user_message"]));
		expect(session.tryAcquireIdleLease()).toBeUndefined();
		errors.length = 0;
		f.setIndex(true);
		expect(await service.archive(f.input)).toMatchObject({ archived: true, cleanupPending: true });
		expect(SessionManager.open(f.file).getEntries().at(-1)).toMatchObject({
			customType: "channel-subs",
			data: { topics: [], cursors: {} },
		});
		api.sendUserMessage("late");
		api.sendMessage({ customType: "late", content: "late", display: true });
		await vi.waitFor(() => expect(errors.sort()).toEqual(["send_message", "send_user_message"]));
		expect(session.tryAcquireIdleLease()).toBeUndefined();
		await expect(service.unarchive({ ...f.input, expectedRevision: 1 })).rejects.toThrow(/cleanup/);
		fail = false;
		await service.retryCleanup(f.id, f.file);
		expect(await service.state(f.id, f.file)).toMatchObject({ archived: true, phase: "archived" });
		expect(JSON.parse(await readFile(join(f.root, "session-archive.json"), "utf8")).records[0].phase).toBe(
			"archived",
		);
		await service.unarchive({ ...f.input, expectedRevision: 1 });
		expect(SessionManager.open(f.file).getEntries().at(-1)).toMatchObject({
			customType: "channel-subs",
			data: { topics: [], cursors: {} },
		});
		await expect(session.prompt("must remain disposed")).rejects.toThrow(/disposed/);
	} finally {
		session.dispose();
	}
});

it("reads a complete header without a newline without changing it", async () => {
	const f = await fixture();
	const header = JSON.stringify({ type: "session", id: f.id });
	await writeFile(f.file, header);
	expect(await readSessionHeaderId(f.file)).toBe(f.id);
	await f.service.assertOpen(f.file);
	expect(await readFile(f.file, "utf8")).toBe(header);
	await writeFile(f.file, header.slice(0, -1));
	await expect(readSessionHeaderId(f.file)).rejects.toThrow();
});

it("does not report a committed deletion as failed when the projection fails", async () => {
	const f = await fixture();
	await f.service.archive(f.input);
	f.setIndex(true);
	await f.service.removeRecord(f.id, f.file);
	await f.service.removeRecord(f.id, f.file);
	expect(await f.service.state(f.id, f.file)).toMatchObject({ phase: "none", revision: 0 });
	const restarted = new SessionArchiveService(f.options);
	await restarted.init();
	expect(await restarted.state(f.id, f.file)).toMatchObject({ phase: "none" });
});

it("invalidates cached authority on external changes and missing marker", async () => {
	const f = await fixture();
	await f.service.archive(f.input);
	const path = join(f.root, "session-archive.json");
	const original = await readFile(path, "utf8");
	await f.service.state(f.id, f.file);
	await writeFile(path, "{}");
	await expect(f.service.state(f.id, f.file)).rejects.toThrow();
	await writeFile(path, original);
	expect(await f.service.state(f.id, f.file)).toMatchObject({ archived: true });
	await rm(join(f.root, "session-archive-initialized.json"));
	await expect(f.service.assertOpen(f.file)).rejects.toThrow(/marker missing/);
});

it("reuses validated authority for reads while still checking the marker", async () => {
	const f = await fixture();
	const spy = vi.spyOn(JsonStore.prototype, "readStrict");
	try {
		await f.service.state(f.id, f.file);
		await f.service.assertOpen(f.file);
		expect(spy).toHaveBeenCalledTimes(2);
	} finally {
		spy.mockRestore();
	}
});

it("refuses to overwrite an externally changed authority during an operation", async () => {
	const f = await fixture();
	const path = join(f.root, "session-archive.json");
	const external = JSON.stringify({ version: 1, records: [] }, null, 2);
	const catalog = f.options.catalog();
	const verify = vi.spyOn(catalog, "verify").mockImplementation(async () => {
		await writeFile(path, external);
		return [{ status: "present", meta: { sessionId: f.id, sessionFile: f.file } }] as never;
	});
	try {
		await expect(f.service.archive(f.input)).rejects.toThrow(/changed before save/);
		expect(await readFile(path, "utf8")).toBe(external);
		expect(f.service.peek(f.id, f.file)).toBeUndefined();
	} finally {
		verify.mockRestore();
	}
});

it("does not publish an uncommitted draft after a failed write", async () => {
	const f = await fixture();
	const spy = vi.spyOn(JsonStore.prototype, "write").mockRejectedValueOnce(new Error("write failed"));
	try {
		await expect(f.service.archive(f.input)).rejects.toThrow(/write failed/);
		expect(f.service.peek(f.id, f.file)).toBeUndefined();
	} finally {
		spy.mockRestore();
	}
});

it("fails closed when authority is missing or malformed", async () => {
	const f = await fixture();
	await f.service.archive(f.input);
	const path = join(f.root, "session-archive.json");
	await writeFile(path, "{}");
	await expect(f.service.state(f.id, f.file)).rejects.toThrow();
	await rm(path);
	const restarted = new SessionArchiveService(f.options);
	await expect(restarted.init()).rejects.toThrow(/missing/);
});
