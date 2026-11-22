import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { SessionMediaStore } from "../src/session/media-store";
import type { ChannelService } from "../src/tools/channels/service";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("discovers a missing-source delete after a backend restart and retries failed media cleanup", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-backend-"));
	roots.push(root);
	const agent = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(agent);
	mkdirSync(project);
	mkdirSync(join(project, ".git"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const media = new SessionMediaStore(join(agent, "media"));
	const cleanup = vi.spyOn(media, "deleteOwner");
	const first = new PiBackend({ sessionMediaStore: media });
	const firstInternal = first as unknown as { channelService(cwd: string): Promise<ChannelService> };
	const service = await firstInternal.channelService(project);
	const source = join(root, "missing.jsonl");
	await service.prepareMaintenance("session", "operation", "delete", source);
	await first.shutdown();

	const second = new PiBackend({ sessionMediaStore: media });
	const internal = second as unknown as { channelService(cwd: string): Promise<ChannelService> };
	cleanup.mockRejectedValueOnce(new Error("media failure"));
	try {
		await expect(internal.channelService(project)).rejects.toThrow("media failure");
		const recovered = await internal.channelService(project);
		expect(cleanup).toHaveBeenCalledTimes(2);
		expect(await recovered.pendingMaintenance()).toMatchObject([
			{ sessionId: "session", opId: "operation", state: "deleted" },
		]);
		await recovered.prepareMaintenance("session", "operation", "delete", source);
		await recovered.completeMaintenance("session", "operation", "deleted");
	} finally {
		await second.shutdown();
	}
});

it("does not delete an existing source during automatic recovery", async () => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-backend-"));
	roots.push(root);
	const agent = join(root, "agent");
	mkdirSync(agent);
	mkdirSync(join(root, ".git"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const media = new SessionMediaStore(join(agent, "media"));
	const cleanup = vi.spyOn(media, "deleteOwner");
	const source = join(root, "session.jsonl");
	writeFileSync(source, "still present");
	const first = new PiBackend({ sessionMediaStore: media });
	const access = (backend: PiBackend) =>
		backend as unknown as { channelService(cwd: string): Promise<ChannelService> };
	await (await access(first).channelService(root)).prepareMaintenance(
		"session",
		"operation",
		"delete",
		source,
	);
	await first.shutdown();
	const second = new PiBackend({ sessionMediaStore: media });
	try {
		const service = await access(second).channelService(root);
		expect(cleanup).not.toHaveBeenCalled();
		expect(await service.pendingMaintenance()).toMatchObject([{ state: "delete" }]);
	} finally {
		await second.shutdown();
	}
});
