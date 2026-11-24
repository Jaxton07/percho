import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { PiBackend } from "../src/pi-backend";
import { SessionArchiveService } from "../src/session/archive";
import { SessionMediaStore } from "../src/session/media-store";
import { ChannelBackendHost } from "../src/tools/channels/backend-host";
import type { ChannelService } from "../src/tools/channels/service";

const injected = vi.hoisted(() => ({ source: "", failAt: 0, calls: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (...args: Parameters<typeof actual.lstat>) => {
			if (args[0] === injected.source && ++injected.calls === injected.failAt)
				throw Object.assign(new Error("denied"), { code: "EACCES" });
			return actual.lstat(...args);
		},
	};
});

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	injected.source = "";
	injected.calls = 0;
	injected.failAt = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(["delete", "deleted"] as const)("reconciles archived deletion interrupted at %s", async (stage) => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-archive-delete-"));
	roots.push(root);
	const agent = join(root, "agent");
	mkdirSync(agent);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const manager = SessionManager.create(root, join(agent, "sessions"));
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const file = manager.getSessionFile() as string;
	const id = manager.getSessionId();
	writeFileSync(join(agent, "session-archive-initialized.json"), JSON.stringify({ version: 1 }));
	writeFileSync(
		join(agent, "session-archive.json"),
		JSON.stringify({
			version: 1,
			records: [{ file, id, revision: 1, opId: "archive-op", archivedAt: Date.now(), phase: "archived" }],
		}),
	);
	const media = new SessionMediaStore(join(agent, "media"));
	const first = new PiBackend({ sessionMediaStore: media });
	const failure =
		stage === "delete"
			? vi.spyOn(media, "deleteOwner").mockRejectedValueOnce(new Error("injected failure"))
			: vi
					.spyOn(SessionArchiveService.prototype, "removeRecord")
					.mockRejectedValueOnce(new Error("injected failure"));
	try {
		await expect(first.deleteSession(id, file)).rejects.toThrow("injected failure");
	} finally {
		failure.mockRestore();
		await first.shutdown();
	}
	const second = new PiBackend({ sessionMediaStore: media });
	try {
		injected.source = file;
		injected.calls = 0;
		injected.failAt = 1;
		await expect(second.querySessionCatalog({ limit: 100 })).rejects.toThrow("denied");
		expect(JSON.parse(readFileSync(join(agent, "session-archive.json"), "utf8")).records).toHaveLength(1);
		injected.source = "";
		await expect(second.querySessionCatalog({ limit: 100 })).resolves.toBeDefined();
		expect(JSON.parse(readFileSync(join(agent, "session-archive.json"), "utf8")).records).toEqual([]);
		await expect(second.querySessionCatalog({ limit: 100 })).resolves.toBeDefined();
	} finally {
		await second.shutdown();
	}
});

it.each(["different archive operation", "missing archive operation ID"])(
	"retains archive authority after interrupted deletion with %s",
	async (scenario) => {
		mkdirSync(".local/tmp", { recursive: true });
		const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-archive-authority-"));
		roots.push(root);
		const agent = join(root, "agent");
		mkdirSync(agent);
		vi.stubEnv("PI_CODING_AGENT_DIR", agent);
		const manager = SessionManager.create(root, join(agent, "sessions"));
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const file = manager.getSessionFile() as string;
		const id = manager.getSessionId();
		const archivePath = join(agent, "session-archive.json");
		const record = { file, id, revision: 1, opId: "archive-op", archivedAt: Date.now(), phase: "archived" };
		writeFileSync(join(agent, "session-archive-initialized.json"), JSON.stringify({ version: 1 }));
		writeFileSync(archivePath, JSON.stringify({ version: 1, records: [record] }));
		const media = new SessionMediaStore(join(agent, "media"));
		const first = new PiBackend({ sessionMediaStore: media });
		const failure = vi.spyOn(media, "deleteOwner").mockRejectedValueOnce(new Error("injected failure"));
		try {
			await expect(first.deleteSession(id, file)).rejects.toThrow("injected failure");
		} finally {
			failure.mockRestore();
			await first.shutdown();
		}
		const host = new ChannelBackendHost(agent, () => {
			throw new Error("unexpected service");
		});
		try {
			const db = new DatabaseSync(join(agent, "channels", "channels.sqlite"), { readOnly: true });
			try {
				const rows = db.prepare("SELECT project, op FROM deletes").all();
				expect(rows).toHaveLength(1);
				const fingerprint = await host.deleteFingerprint(String(rows[0].project), String(rows[0].op));
				expect(fingerprint).toMatchObject({ id, archiveOperationId: "archive-op" });
			} finally {
				db.close();
			}
		} finally {
			await host.close();
		}
		if (scenario === "different archive operation") {
			record.opId = "restored-archive-op";
			writeFileSync(archivePath, JSON.stringify({ version: 1, records: [record] }));
		} else {
			const db = new DatabaseSync(join(agent, "channels", "channels.sqlite"));
			try {
				const rows = db.prepare("SELECT project, op, fingerprint FROM deletes").all();
				expect(rows).toHaveLength(1);
				for (const row of rows) {
					const fingerprint = JSON.parse(String(row.fingerprint));
					delete fingerprint.archiveOperationId;
					db.prepare("UPDATE deletes SET fingerprint = ? WHERE project = ? AND op = ?").run(
						JSON.stringify(fingerprint),
						String(row.project),
						String(row.op),
					);
				}
			} finally {
				db.close();
			}
		}
		const second = new PiBackend({ sessionMediaStore: media });
		try {
			for (let i = 0; i < 2; i++) {
				await expect(second.querySessionCatalog({ limit: 100 })).rejects.toThrow();
				expect(JSON.parse(readFileSync(archivePath, "utf8")).records).toEqual([record]);
			}
		} finally {
			await second.shutdown();
		}
	},
);

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
	const source = join(root, "missing.jsonl");
	try {
		const service = await firstInternal.channelService(project);
		await service.prepareMaintenance("session", "operation", "delete", source);
	} finally {
		await first.shutdown();
	}

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

it.each([1, 2])("retains the fence when source lstat fails at check %i", async (failAt) => {
	mkdirSync(".local/tmp", { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".local/tmp/channel-recovery-error-"));
	roots.push(root);
	const agent = join(root, "agent");
	mkdirSync(agent);
	vi.stubEnv("PI_CODING_AGENT_DIR", agent);
	const media = new SessionMediaStore(join(agent, "media"));
	const cleanup = vi.spyOn(media, "deleteOwner");
	const backend = new PiBackend({ sessionMediaStore: media });
	const internal = backend as unknown as {
		channelService(cwd: string): Promise<ChannelService>;
		recoverChannelDeletes(): Promise<void>;
	};
	try {
		const service = await internal.channelService(root);
		const source = join(root, "missing.jsonl");
		await service.prepareMaintenance("session", "operation", "delete", source);
		injected.source = source;
		injected.failAt = failAt;
		await expect(internal.recoverChannelDeletes()).rejects.toThrow("denied");
		expect(cleanup).not.toHaveBeenCalled();
		expect(await service.pendingMaintenance()).toMatchObject([{ state: "delete" }]);
	} finally {
		await backend.shutdown();
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
	try {
		await (await access(first).channelService(root)).prepareMaintenance(
			"session",
			"operation",
			"delete",
			source,
		);
	} finally {
		await first.shutdown();
	}
	const second = new PiBackend({ sessionMediaStore: media });
	try {
		const service = await access(second).channelService(root);
		expect(cleanup).not.toHaveBeenCalled();
		expect(await service.pendingMaintenance()).toMatchObject([{ state: "delete" }]);
	} finally {
		await second.shutdown();
	}
});
