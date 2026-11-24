import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { ChannelBackendHost } from "../src/tools/channels/backend-host";
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

function response(tool: boolean): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: tool ? "toolUse" : "stop",
		content: tool
			? [{ type: "toolCall", id: "call-1", name: "channel_read", arguments: { topic: "work" } }]
			: [{ type: "text", text: "done" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test("production backend carries unread projection through real SDK tool continuation without read-only writes", async () => {
	const base = resolve("../../.local/tmp/channels-production-sdk");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "case-"));
	fixture.root = join(dir, "project");
	fixture.agent = join(dir, "agent");
	mkdirSync(fixture.root);
	mkdirSync(fixture.agent);
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	process.env.HOME = dir;
	process.env.PI_CODING_AGENT_DIR = fixture.agent;
	writeFileSync(
		join(fixture.agent, "settings.json"),
		JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }),
	);
	new ProjectTrustStore(fixture.agent).set(fixture.root, true);
	const backend = new PiBackend({ permissionGates: false });
	try {
		const meta = await backend.createSession({ cwd: fixture.root });
		const registry = (backend as unknown as { registry: import("../src/session/registry").SessionRegistry })
			.registry;
		const entry = registry.get(meta.sessionId);
		if (!entry) throw new Error("Missing actual session");
		const session = entry.session;
		const service = await (
			backend as unknown as { channelService(cwd: string, root: string): Promise<ChannelService> }
		).channelService(fixture.root, fixture.root);
		await service.manage({ sessionId: meta.sessionId }, { action: "create", topic: "work" });
		await service.manage({ sessionId: "other" }, { action: "subscribe", topic: "work" });
		for (let i = 0; i < 5; i++)
			await service.post({ sessionId: "other" }, "work", `message-${i}`, `post-${i}`);
		session.agent.state.model = model;
		const runtime = (session as unknown as { _modelRuntime: { checkAuth: () => Promise<unknown> } })
			._modelRuntime;
		vi.spyOn(runtime, "checkAuth").mockResolvedValue({ type: "api_key", key: "fixture" });
		const requests: Array<Parameters<NonNullable<typeof session.agent.streamFunction>>[1]> = [];
		let invokeTool = false;
		session.agent.streamFunction = async (_model, context) => {
			requests.push(structuredClone(context));
			const message = response(invokeTool && requests.length === 1);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			return stream;
		};
		const register = vi.spyOn(ChannelBackendHost.prototype, "register");
		const fences = vi.spyOn(ChannelBackendHost.prototype, "fences");
		const channelDir = join(fixture.agent, "channels");
		const names = readdirSync(channelDir);
		expect(names.some((name) => name.endsWith(".sqlite"))).toBe(true);
		expect(names.some((name) => name.endsWith(".json"))).toBe(true);
		const snapshot = () => {
			const files = readdirSync(channelDir)
				.sort()
				.map((name) => join(channelDir, name));
			return files.map((file) => ({
				file,
				bytes: readFileSync(file).toString("base64"),
				mtime: statSync(file).mtimeMs,
			}));
		};
		const before = snapshot();
		await session.prompt("final only");
		expect(register).not.toHaveBeenCalled();
		expect(fences).not.toHaveBeenCalled();
		expect(snapshot()).toEqual(before);
		requests.length = 0;
		invokeTool = true;
		await session.prompt("read the channel");
		expect(requests).toHaveLength(2);
		const first = requests[0];
		expect(JSON.stringify(first)).toContain("可自行决定是否读取");
		expect(JSON.stringify(first.messages[0])).toContain("system");
		const system = first.messages[0];
		if (system.role !== "system") throw new Error("Missing system message");
		expect(
			system.toolsAdded
				?.filter((tool) => tool.name.startsWith("channel_"))
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["channel_manage", "channel_post", "channel_read"]);
		expect(first.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "user",
					content: expect.arrayContaining([
						expect.objectContaining({ text: expect.stringContaining('"unread":5') }),
					]),
				}),
			]),
		);
		const second = requests[1];
		expect(JSON.stringify(second.messages)).toContain("call-1");
		expect(second.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "toolResult", toolCallId: "call-1", isError: false }),
			]),
		);
		expect((await service.snapshot(meta.sessionId)).find((item) => item.topic === "work")?.unread).toBe(0);
		expect(JSON.stringify(second.messages)).toContain("message-0");
		expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("可自行决定是否读取");
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing session JSONL");
		expect(readFileSync(sessionFile, "utf8")).not.toContain("可自行决定是否读取");
		requests.length = 0;
		invokeTool = false;
		await session.prompt("check again");
		expect(JSON.stringify(requests[0].messages)).not.toContain("可自行决定是否读取");
	} finally {
		vi.restoreAllMocks();
		await backend.shutdown();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);
