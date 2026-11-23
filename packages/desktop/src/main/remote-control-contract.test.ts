import { REMOTE_CHANNELS } from "@percho/shared";
import { describe, expect, it } from "vitest";

describe("desktop SSH control requests", () => {
	it("requires the observed connection identity and generation for destructive control", () => {
		const command = { epoch: "desktop", generation: 4, connectionId: "server-a" };
		expect(() => REMOTE_CHANNELS.remoteDisconnect.validate(command)).not.toThrow();
		expect(() => REMOTE_CHANNELS.remoteDisconnect.validate(undefined)).toThrow();
		expect(() => REMOTE_CHANNELS.remoteDisconnect.validate({ ...command, generation: -1 })).toThrow();
	});
	it("requires catalog revision as well as the slot generation when adding a host", () => {
		const channels = REMOTE_CHANNELS as Record<string, { validate(value: unknown): void }>;
		expect(channels.remoteAdd).toBeDefined();
		const command = { epoch: "desktop", generation: 4, catalogRevision: 3, alias: "server-a" };
		expect(() => channels.remoteAdd?.validate(command)).not.toThrow();
		expect(() => channels.remoteAdd?.validate({ alias: "server-a" })).toThrow();
	});
});
