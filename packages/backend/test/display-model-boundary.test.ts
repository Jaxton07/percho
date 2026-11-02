import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
	createAgentSession,
	createExtensionRuntime,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { SessionMediaStore } from "../src/session/media-store";
import type { SessionRegistry } from "../src/session/registry";
import { SessionSourceSnapshots } from "../src/session/source-snapshot";

const model = {
	id: "display-boundary",
	name: "display-boundary",
	provider: "synthetic",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 128000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-completions">;
const response: AssistantMessage = {
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	timestamp: 9,
	stopReason: "stop",
	content: [{ type: "text", text: "synthetic response" }],
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const loader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => "Synthetic offline test",
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: () => {},
	reload: async () => {},
};

describe("展示引用不能进入真实SDK模型输入", () => {
	it("历史用户附件、read图及本次发送图片保留原字节，投影不修改权威SDK树", async () => {
		const root = resolve("../../.local/tmp/display-model-boundary");
		mkdirSync(root, { recursive: true });
		const directory = mkdtempSync(`${root}/run-`);
		const manager = SessionManager.inMemory(directory);
		const original = { type: "image" as const, mimeType: "image/png", data: "AQID" };
		manager.appendMessage({
			role: "user",
			timestamp: 1,
			content: [{ type: "text", text: "prior" }, original],
		});
		manager.appendMessage({
			...response,
			timestamp: 2,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "read",
			toolName: "read",
			isError: false,
			timestamp: 3,
			content: [{ ...original, data: "BAUG" }],
		});
		manager.appendMessage({ ...response, timestamp: 4 });
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			model,
			sessionManager: manager,
			modelRuntime: {
				getModel: () => model,
				hasConfiguredAuth: () => true,
				checkAuth: async () => ({ type: "api_key", key: "synthetic-test-only" }),
				getAuth: async () => undefined,
			} as unknown as ModelRuntime,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				cacheWarming: "off",
			}),
			resourceLoader: loader,
			noTools: "all",
		});
		try {
			const source = new SessionSourceSnapshots();
			const owner = {};
			const before = JSON.stringify(manager.getEntries());
			const view = source.capture(owner, {
				sessionId: session.sessionId,
				branch: () => manager.getBranch(),
				entries: () => manager.getEntries(),
			});
			const display = source.project(view);
			expect(display.find((message) => message.role === "user")?.images[0]).toMatchObject({
				kind: "reference",
			});
			expect(JSON.stringify(manager.getEntries())).toBe(before);
			const requests: unknown[] = [],
				bodies: unknown[] = [];
			const forbiddenNetwork = vi.fn(async () => {
				throw new Error("Network is forbidden in this offline test");
			});
			session.agent.streamFunction = async (_model, context, options) => {
				requests.push(structuredClone(context.messages));
				return streamSimple(model, context, {
					...options,
					apiKey: "synthetic-test-only",
					transport: "sse",
					fetch: forbiddenNetwork,
					onPayload: (payload) => {
						bodies.push(structuredClone(payload));
						throw new Error("CAPTURE_ONLY");
					},
				});
			};
			const fresh = {
				type: "image" as const,
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
			};
			await session.prompt("next", { images: [fresh, { ...fresh }] });
			const actual = JSON.stringify(requests);
			expect(requests).toHaveLength(1);
			expect(actual).toContain("AQID");
			expect(actual).toContain("BAUG");
			expect(actual).toContain(fresh.data);
			expect(actual).not.toContain('"kind":"reference"');
			expect(actual).not.toContain("entry:");
			expect(bodies).toHaveLength(1);
			expect(forbiddenNetwork).not.toHaveBeenCalled();
			const encoded = JSON.stringify(bodies);
			for (const data of ["AQID", "BAUG", fresh.data])
				expect(encoded).toContain(`data:image/png;base64,${data}`);
			expect(encoded.split(`data:image/png;base64,${fresh.data}`).length - 1).toBe(2);
			expect(encoded).not.toContain('"kind":"reference"');
			expect(encoded).not.toContain("entry:");
			source.release(owner);
			expect(source.stats().views).toBe(0);
			const backend = new PiBackend({
				projectTrust: false,
				permissionGates: false,
				sessionMediaStore: new SessionMediaStore(resolve(directory, "media")),
			});
			(backend as unknown as { registry: SessionRegistry }).registry.add({
				session,
				cwd: directory,
				unsubscribe: () => {},
				gate: { dispose: () => {} } as never,
				dialogs: { dispose: () => {} } as never,
				modeRef: { current: "default" },
			});
			try {
				const originalTree = JSON.stringify(manager.getEntries());
				const baseline = backend.getSessionBaseline(session.sessionId, { imageMode: "references" });
				const user = baseline.transcript.messages.findLast((message) => message.kind === "user");
				if (user?.kind !== "user") throw new Error("Missing baseline user");
				expect(user.images).toHaveLength(2);
				for (const image of user.images) {
					if (!("id" in image)) throw new Error("Inline image in baseline");
					expect(image).toMatchObject({ kind: "reference", ownerSessionId: session.sessionId });
					expect((await backend.getSessionImage(session.sessionId, image.id, image.revision)).data).toBe(
						fresh.data,
					);
				}
				expect(JSON.stringify(baseline)).not.toContain(fresh.data);
				expect(JSON.stringify(manager.getEntries())).toBe(originalTree);
				await backend.closeSession(session.sessionId);
				expect(backend.getSessionSourceStats().views).toBe(0);
			} finally {
				backend.dispose();
			}
		} finally {
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
