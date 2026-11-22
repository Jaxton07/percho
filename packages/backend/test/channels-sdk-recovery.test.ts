import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import type { SessionRegistry } from "../src/session/registry";
import type { ChannelService } from "../src/tools/channels/service";

const fixture = vi.hoisted(() => ({ agent: "", root: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => fixture.agent,
}));
vi.mock("../src/tools/channels/project", () => ({ resolveChannelProject: async () => fixture.root }));
const { PiBackend } = await import("../src/pi-backend");

const model: Model<"openai-completions"> = {
	id: "offline",
	name: "offline",
	provider: "fixture",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function answer(failure = false): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: failure ? "error" : "stop",
		...(failure ? { errorMessage: "fixture failure" } : {}),
		content: [{ type: "text", text: failure ? "failed" : "fixture summary or answer" }],
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
async function setup() {
	const base = resolve("../../.local/tmp/channels-sdk-recovery");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "case-"));
	fixture.root = join(dir, "project");
	fixture.agent = join(dir, "agent");
	mkdirSync(fixture.root);
	mkdirSync(fixture.agent);
	const home = process.env.HOME,
		agent = process.env.PI_CODING_AGENT_DIR;
	process.env.HOME = dir;
	process.env.PI_CODING_AGENT_DIR = fixture.agent;
	writeFileSync(
		join(fixture.agent, "settings.json"),
		JSON.stringify({
			cacheWarming: "off",
			compaction: { enabled: false, keepRecentTokens: 50 },
			retry: { enabled: false },
		}),
	);
	new ProjectTrustStore(fixture.agent).set(fixture.root, true);
	const backend = new PiBackend({ permissionGates: false });
	const meta = await backend.createSession({ cwd: fixture.root });
	const entry = (backend as unknown as { registry: SessionRegistry }).registry.get(meta.sessionId);
	if (!entry) throw new Error("missing session");
	const session = entry.session;
	const service = await (
		backend as unknown as { channelService(cwd: string, root: string): Promise<ChannelService> }
	).channelService(fixture.root, fixture.root);
	await service.manage({ sessionId: meta.sessionId }, { action: "create", topic: "work" });
	await service.manage({ sessionId: "other" }, { action: "subscribe", topic: "work" });
	session.agent.state.model = model;
	vi.spyOn(session.modelRuntime, "checkAuth").mockResolvedValue({ type: "api_key", key: "fixture" });
	const requests: unknown[][] = [];
	let fail = false;
	session.agent.streamFunction = async (_model, context) => {
		requests.push(structuredClone(context.messages));
		const message = answer(fail);
		fail = false;
		const stream = createAssistantMessageEventStream();
		if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
		else stream.push({ type: "done", reason: "stop", message });
		return stream;
	};
	return {
		backend,
		session,
		service,
		requests,
		id: meta.sessionId,
		fail: () => {
			fail = true;
		},
		post: (text: string) => service.post({ sessionId: "other" }, "work", text, text),
		close: async () => {
			await backend.shutdown();
			vi.restoreAllMocks();
			if (home === undefined) delete process.env.HOME;
			else process.env.HOME = home;
			if (agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = agent;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
function checkProjection(messages: unknown[] | undefined, unread: number) {
	if (!messages) throw new Error("missing request");
	const text = JSON.stringify(messages);
	expect(text.match(/可自行决定是否读取/g)).toHaveLength(1);
	expect(text).toContain(`\\"unread\\":${unread}`);
}
function checkNotPersisted(session: Awaited<ReturnType<typeof setup>>["session"]) {
	expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("可自行决定是否读取");
	const file = session.sessionManager.getSessionFile();
	if (!file) throw new Error("missing session file");
	expect(readFileSync(file, "utf8")).not.toContain("可自行决定是否读取");
}

test("failed real turn retries with one fresh transient unread projection", async () => {
	const f = await setup();
	try {
		await f.post("first");
		f.fail();
		await f.session.prompt("fail once");
		checkProjection(f.requests[0], 1);
		const failed = f.session.sessionManager
			.getBranch()
			.findLast((e) => e.type === "message" && e.message.role === "assistant");
		if (failed?.type !== "message") throw new Error("missing failure");
		await f.post("second");
		await f.session.retryLastFailedTurn({ entryId: failed.id, timestamp: failed.message.timestamp });
		expect(f.requests).toHaveLength(2);
		checkProjection(f.requests[1], 2);
		await f.session.prompt("another natural request");
		checkProjection(f.requests[2], 2);
		expect((await f.service.snapshot(f.id)).find((x) => x.topic === "work")?.unread).toBe(2);
		checkNotPersisted(f.session);
	} finally {
		await f.close();
	}
}, 30000);

test("posting during a real SDK compaction pause neither starts nor resumes a request", async () => {
	const f = await setup();
	try {
		let starts = 0;
		const off = f.session.subscribe((event) => {
			if (event.type === "agent_start") starts++;
		});
		try {
			f.session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 50 } });
			await f.session.setModel({ ...model, contextWindow: 2000 });
			await f.session.prompt("oversized ".repeat(3000));
			expect(f.session.compactionPause).not.toBeNull();
			const pause = f.session.compactionPause;
			const beforeStarts = starts,
				beforeRequests = f.requests.length;
			await f.post("arrived while paused");
			expect(starts).toBe(beforeStarts);
			expect(f.requests).toHaveLength(beforeRequests);
			expect(f.session.compactionPause).toEqual(pause);
			await f.session.setModel(model);
			await f.session.prompt("resume manually");
			expect(f.session.compactionPause).toBeNull();
			expect(f.requests.length).toBeGreaterThan(beforeRequests);
			checkProjection(f.requests.at(-1), 1);
			checkNotPersisted(f.session);
		} finally {
			off();
		}
	} finally {
		await f.close();
	}
}, 30000);

test("manual SDK compaction does not consume unread messages", async () => {
	const f = await setup();
	try {
		for (let i = 0; i < 4; i++) await f.session.prompt(`history ${i} ${"text ".repeat(300)}`);
		await f.post("unread during compact");
		const beforeCompact = f.requests.length;
		await f.session.compact();
		expect(f.requests.length).toBeGreaterThan(beforeCompact);
		expect(JSON.stringify(f.requests[beforeCompact])).toContain("context summarization assistant");
		expect(f.session.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(true);
		expect((await f.service.snapshot(f.id)).find((x) => x.topic === "work")?.unread).toBe(1);
		await f.session.prompt("after compaction");
		checkProjection(f.requests.at(-1), 1);
		checkNotPersisted(f.session);
	} finally {
		await f.close();
	}
}, 30000);
