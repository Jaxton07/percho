import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { SessionMediaStore } from "../src/session/media-store";
import type { ChannelService } from "../src/tools/channels/service";

it("refuses to delete a recreated same-id file through the public entry", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-recreated-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const media = new SessionMediaStore(join(agent, "media"));
	vi.spyOn(media, "deleteOwner").mockRejectedValueOnce(new Error("media failure"));
	const backend = new PiBackend({ sessionMediaStore: media });
	const internal = backend as unknown as {
		archives: () => Promise<unknown>;
		getSessionCatalog: () => unknown;
	};
	internal.archives = async () => ({ state: async () => ({}), removeRecord: async () => {} });
	internal.getSessionCatalog = () => ({ verify: async () => [{ status: "missing" }] });
	const source = join(root, "session.jsonl");
	const content = `${JSON.stringify({ type: "session", id: "session", cwd: root })}\n`;
	writeFileSync(source, content);
	try {
		await expect(backend.deleteSession("session", source)).rejects.toThrow("media failure");
		writeFileSync(source, content);
		await expect(backend.deleteSession("session", source)).rejects.toThrow("identity changed");
		expect(existsSync(source)).toBe(true);
		unlinkSync(source);
		await backend.deleteSession("session", source);
		writeFileSync(source, content);
		await expect(backend.deleteSession("session", source)).rejects.toThrow("identity changed");
		expect(existsSync(source)).toBe(true);
	} finally {
		await backend.shutdown();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});

it("reuses the delete fence after unlink and media cleanup failure", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-delete-"));
	const agent = join(root, "agent");
	mkdirSync(agent);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const media = new SessionMediaStore(join(agent, "media"));
	vi.spyOn(media, "deleteOwner").mockRejectedValueOnce(new Error("media failure"));
	const backend = new PiBackend({ sessionMediaStore: media });
	const internal = backend as unknown as {
		channelService(cwd: string): Promise<ChannelService>;
		deleteSessionUnlocked(id: string, file: string): Promise<string>;
		archives: () => Promise<unknown>;
		getSessionCatalog: () => unknown;
	};
	const source = join(root, "session.jsonl");
	writeFileSync(source, `${JSON.stringify({ type: "session", id: "session", cwd: root })}\n`);
	internal.archives = async () => ({});
	internal.getSessionCatalog = () => ({ verify: async () => [{ status: "missing" }] });
	try {
		const service = await internal.channelService(root);
		await expect(internal.deleteSessionUnlocked("session", source)).rejects.toThrow("media failure");
		const [fence] = await service.pendingMaintenance();
		expect(fence?.state).toBe("delete");
		await expect(internal.deleteSessionUnlocked("session", source)).resolves.toBe(source);
		expect(await service.pendingMaintenance()).toMatchObject([{ opId: fence?.opId, state: "deleted" }]);
		await expect(internal.deleteSessionUnlocked("session", source)).resolves.toBe(source);
	} finally {
		await backend.shutdown();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	}
});
