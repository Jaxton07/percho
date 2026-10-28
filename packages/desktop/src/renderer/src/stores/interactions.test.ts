import { type EnvironmentRef, emptyTranscript, environmentEntityKey } from "@percho/shared";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ getPendingInteractions: vi.fn() }));
vi.mock("../api", () => ({ getPi: () => api }));
const api = { forEnvironment: () => fixture };

import {
	acceptInteractionEvent,
	canAnswerInteraction,
	invalidateInteractions,
	synchronizeInteractions,
	useInteractionStore,
} from "./interactions";
import { useTranscriptStore } from "./transcript";

const env: EnvironmentRef = { kind: "ssh", connectionId: "interaction-test", environmentId: "remote-data" };
const snapshot = (revision: number) => ({
	revision,
	permissions: [{ id: "same", sessionId: "same", title: "remote", message: "request", kind: "command" }],
	dialogs: [],
	trust: [],
});
describe("pending interaction reconciliation", () => {
	it("installs only still pending remote requests and later resolutions, retaining same-ID local state", async () => {
		const id = environmentEntityKey(env, "same");
		useTranscriptStore.setState({
			bySession: {
				same: {
					...emptyTranscript(),
					pendingPermissions: [
						{ id: "same", sessionId: "same", title: "local", message: "keep", kind: "other" },
					],
					pendingDialogs: [],
				},
			},
		});
		const local = useTranscriptStore.getState().bySession.same;
		let release!: (value: unknown) => void;
		fixture.getPendingInteractions.mockImplementationOnce(
			() => new Promise((resolve) => (release = resolve)),
		);
		invalidateInteractions(env);
		expect(canAnswerInteraction(id)).toBe(false);
		const syncing = synchronizeInteractions(env);
		acceptInteractionEvent(env, 12, {}, () => useTranscriptStore.getState().resolvePermission(id, id));
		release(snapshot(11));
		await syncing;
		expect(canAnswerInteraction(id)).toBe(true);
		expect(useTranscriptStore.getState().bySession[id]?.pendingPermissions).toEqual([]);
		expect(useTranscriptStore.getState().bySession.same).toBe(local);
		invalidateInteractions(env);
		expect(canAnswerInteraction(id)).toBe(false);
	});
	it("a stale snapshot cannot enable answers or replace requests after another disconnect", async () => {
		const id = environmentEntityKey(env, "same");
		let release!: (value: unknown) => void;
		fixture.getPendingInteractions.mockImplementationOnce(
			() => new Promise((resolve) => (release = resolve)),
		);
		invalidateInteractions(env);
		const stale = synchronizeInteractions(env);
		invalidateInteractions(env);
		release(snapshot(20));
		await stale;
		expect(canAnswerInteraction(id)).toBe(false);
		fixture.getPendingInteractions.mockResolvedValueOnce({
			revision: 21,
			permissions: [],
			dialogs: [],
			trust: [],
		});
		await synchronizeInteractions(env);
		expect(canAnswerInteraction(id)).toBe(true);
		expect(useInteractionStore.getState().trustRequests).toEqual([]);
	});
});
