import {
	composerDocumentFromText,
	type EnvironmentRef,
	environmentEntityKey,
	environmentEntityRef,
	LOCAL_ENVIRONMENT,
} from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
	const makeApi = () => {
		const events = new Set<(payload: unknown) => void>();
		const permissions = new Set<(payload: unknown) => void>();
		const meta = {
			sessionId: "same-id",
			sessionFile: "/same/history.jsonl",
			cwd: "/same",
			active: true,
			messageCount: 0,
			createdAt: 1,
		};
		return {
			events,
			permissions,
			createSession: vi.fn(async () => meta),
			openSession: vi.fn(async () => meta),
			getSessionMessages: vi.fn(async (): Promise<unknown[]> => []),
			getFollowUpMessages: vi.fn(async () => []),
			getTodos: vi.fn(async () => []),
			getPermissionMode: vi.fn(async () => "default"),
			setPermissionMode: vi.fn(async () => {}),
			markSessionHistoryReady: vi.fn(async () => {}),
			ensureProjectTrust: vi.fn(async () => true),
			prompt: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			respondPermission: vi.fn(async () => {}),
			saveUiState: vi.fn(async () => {}),
			onEvent: vi.fn((cb: (payload: unknown) => void) => {
				events.add(cb);
				return () => {
					events.delete(cb);
				};
			}),
			onPermissionRequest: vi.fn((cb: (payload: unknown) => void) => {
				permissions.add(cb);
				return () => {
					permissions.delete(cb);
				};
			}),
		};
	};
	const remote = makeApi(),
		local = makeApi();
	return { remote, local: { ...local, forEnvironment: vi.fn(() => remote) } };
});
vi.mock("./api", () => ({ getPi: () => fixture.local }));

import { getExecutionApi, subscribeExecutionEnvironments } from "./environment-api";
import { registerEnvironment } from "./environment-registry";
import { NEW_SESSION_DRAFT_KEY, newSessionDraftKey, useDraftStore } from "./stores/drafts";
import { clearSessionHistory } from "./stores/session-history";
import { useSessionWorkspaceStore } from "./stores/session-workspace";
import { useSessionsStore } from "./stores/sessions";
import { useTranscriptStore } from "./stores/transcript";
import { useUiPreferencesStore } from "./stores/ui-preferences";

const remote: EnvironmentRef = { kind: "ssh", connectionId: "company", environmentId: "remote-data" };
const disposers: Array<() => void> = [];

beforeEach(() => {
	vi.clearAllMocks();
	fixture.local.events.clear();
	fixture.remote.events.clear();
	fixture.local.permissions.clear();
	fixture.remote.permissions.clear();
	fixture.remote.getSessionMessages.mockResolvedValue([]);
	for (const session of useSessionsStore.getState().sessions) clearSessionHistory(session.sessionId);
	useSessionsStore.setState({
		sessions: [],
		activeSessionId: null,
		newSessionDraft: null,
		cwd: null,
		permissionModes: {},
		lastUsedModel: null,
		lastUsedThinkingLevel: "medium",
		lastUsedAt: {},
	});
	useTranscriptStore.setState({ bySession: {} });
	useDraftStore.setState({ bySession: {}, failedBySession: {}, pendingBySession: {}, errorsBySession: {} });
	useSessionWorkspaceStore.setState({ members: [], activeFile: null, epoch: 0 });
	useUiPreferencesStore.setState({ sessionPermissionModes: {} });
});
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
});

describe("session ownership through the actual renderer execution boundary", () => {
	it("opens identical local/remote session IDs independently and sends only raw IDs to their owner", async () => {
		const local = await getExecutionApi(LOCAL_ENVIRONMENT).openSession({ filePath: "/same/history.jsonl" });
		const file = environmentEntityKey(remote, "/same/history.jsonl");
		const foreign = await getExecutionApi(file).openSession({ filePath: file });
		expect(local.sessionId).toBe("same-id");
		expect(foreign.sessionId).not.toBe(local.sessionId);
		await getExecutionApi(foreign.sessionId).prompt({ sessionId: foreign.sessionId, text: "remote" });
		await getExecutionApi(local.sessionId).prompt({ sessionId: local.sessionId, text: "local" });
		expect(fixture.remote.prompt).toHaveBeenCalledExactlyOnceWith({ sessionId: "same-id", text: "remote" });
		expect(fixture.local.prompt).toHaveBeenCalledExactlyOnceWith({ sessionId: "same-id", text: "local" });
		await expect(getExecutionApi(LOCAL_ENVIRONMENT).abort({ sessionId: foreign.sessionId })).rejects.toThrow(
			"different execution",
		);
		expect(fixture.local.abort).not.toHaveBeenCalled();
	});

	it("merges interleaved source events into separate transcripts without a selected backend", () => {
		disposers.push(
			subscribeExecutionEnvironments((api) =>
				api.onEvent(({ sessionId, event }) => {
					useTranscriptStore.getState().applyEvent(sessionId, event);
				}),
			),
		);
		disposers.push(registerEnvironment(remote));
		for (const cb of fixture.local.events) cb({ sessionId: "same-id", event: { type: "agent_start" } });
		for (const cb of fixture.remote.events) cb({ sessionId: "same-id", event: { type: "agent_start" } });
		for (const cb of fixture.local.events) cb({ sessionId: "same-id", event: { type: "agent_settled" } });
		const entries = useTranscriptStore.getState().bySession;
		expect(entries["same-id"]?.agentActive).toBe(false);
		expect(entries[environmentEntityKey(remote, "same-id")]?.agentActive).toBe(true);
	});

	it("promotes the captured remote draft and leaves local input untouched", async () => {
		useDraftStore.getState().updateDraft(NEW_SESSION_DRAFT_KEY, (entry) => ({
			...entry,
			document: composerDocumentFromText("local input"),
		}));
		useSessionsStore.getState().activateNewSessionDraftForCwd("/same", remote);
		const key = newSessionDraftKey(remote, "/same");
		useDraftStore
			.getState()
			.updateDraft(key, (entry) => ({ ...entry, document: composerDocumentFromText("remote input") }));
		const sessionId = await useSessionsStore.getState().createSession();
		expect(sessionId).toBe(environmentEntityKey(remote, "same-id"));
		expect(fixture.local.createSession).not.toHaveBeenCalled();
		expect(fixture.remote.createSession).toHaveBeenCalledWith({
			options: { cwd: "/same", thinkingLevel: "medium" },
		});
		expect(useDraftStore.getState().bySession[NEW_SESSION_DRAFT_KEY]?.document).toEqual(
			composerDocumentFromText("local input"),
		);
		expect(useDraftStore.getState().bySession[sessionId as string]?.document).toEqual(
			composerDocumentFromText("remote input"),
		);
		expect(useDraftStore.getState().bySession[key]).toBeUndefined();
	});

	it("changes ownership generation instead of reusing an in-flight draft after changing environments", () => {
		useSessionsStore.getState().activateNewSessionDraftForCwd("/same");
		const previous = useSessionsStore.getState().newSessionDraft?.generation;
		useSessionsStore.getState().setDraftCwd("/same", remote);
		expect(useSessionsStore.getState().newSessionDraft?.generation).not.toBe(previous);
		expect(useSessionsStore.getState().newSessionDraft?.environment).toEqual(remote);
	});

	it("never restores a persisted remote fullAccess preference when reopening a session", async () => {
		const sessionId = environmentEntityKey(remote, "same-id");
		useUiPreferencesStore.setState({ sessionPermissionModes: { [sessionId]: "fullAccess" } });
		const result = await useSessionsStore
			.getState()
			.openFromHistory(environmentEntityKey(remote, "/same/history.jsonl"));
		expect(result.ok).toBe(true);
		expect(useSessionsStore.getState().permissionModes[sessionId]).toBeUndefined();
		expect(fixture.remote.setPermissionMode).not.toHaveBeenCalled();
	});

	it("keeps nested subagent navigation scoped but preserves arbitrary tool content", async () => {
		let received: unknown;
		const off = getExecutionApi(remote).onEvent((event) => {
			received = event;
		});
		disposers.push(off);
		const payload = {
			sessionId: "same-id",
			event: {
				type: "tool_execution_end",
				toolName: "subagent",
				toolCallId: "t",
				isError: false,
				result: {
					content: [{ type: "text", text: "/literal/tool-output" }],
					details: {
						cwd: "/literal/cwd",
						results: [{ agent: "reviewer", sessionFile: "/same/child.jsonl" }],
					},
				},
			},
		};
		for (const cb of fixture.remote.events) cb(payload);
		expect(received).toMatchObject({
			sessionId: environmentEntityKey(remote, "same-id"),
			event: {
				result: {
					content: payload.event.result.content,
					details: {
						cwd: "/literal/cwd",
						results: [{ sessionFile: environmentEntityKey(remote, "/same/child.jsonl") }],
					},
				},
			},
		});
		expect(payload.event.result.details.results[0]?.sessionFile).toBe("/same/child.jsonl");
		fixture.remote.getSessionMessages.mockResolvedValue([
			{ role: "subagent", runs: [{ agent: "reviewer", sessionFile: "/same/child.jsonl" }], timestamp: 1 },
		]);
		const history = await getExecutionApi(remote).getSessionMessages({
			sessionId: environmentEntityKey(remote, "same-id"),
		});
		expect(history[0]).toMatchObject({
			runs: [{ sessionFile: environmentEntityKey(remote, "/same/child.jsonl") }],
		});
	});

	it("routes a delayed approval by the original request identity", async () => {
		let requestId = "";
		disposers.push(
			getExecutionApi(remote).onPermissionRequest((request) => {
				requestId = request.id;
			}),
		);
		for (const cb of fixture.remote.permissions)
			cb({ id: "request", sessionId: "same-id", title: "approve", message: "command", kind: "command" });
		await getExecutionApi(requestId).respondPermission({ requestId, answer: "allow" });
		expect(fixture.remote.respondPermission).toHaveBeenCalledExactlyOnceWith({
			requestId: "request",
			answer: "allow",
		});
		expect(fixture.local.respondPermission).not.toHaveBeenCalled();
	});

	it("escapes reserved-prefix local values so even adversarial identical strings cannot collide", () => {
		const remoteKey = environmentEntityKey(remote, "same-id");
		const escapedLocal = environmentEntityKey(LOCAL_ENVIRONMENT, remoteKey);
		expect(escapedLocal).not.toBe(remoteKey);
		expect(environmentEntityRef(escapedLocal)).toEqual({ environment: LOCAL_ENVIRONMENT, id: remoteKey });
	});
});
