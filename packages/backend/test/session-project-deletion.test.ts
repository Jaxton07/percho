import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionMeta } from "@percho/shared";
import { afterEach, expect, it, vi } from "vitest";
import { SessionCatalog } from "../src/session/catalog.js";
import { SessionProjectDeletion } from "../src/session/project-deletion.js";

const root = resolve(import.meta.dirname, "../../../.local/tmp/session-archive-catalog/ticket06");
const cwd = "/project";
let catalog: SessionCatalog | undefined;
afterEach(async () => {
	vi.useRealTimers();
	await catalog?.dispose();
	catalog = undefined;
	await rm(root, { recursive: true, force: true });
});

async function setup() {
	await rm(root, { recursive: true, force: true });
	const dir = join(root, "sessions", "project");
	await mkdir(dir, { recursive: true });
	const file = (id: string) => join(dir, `${id}.jsonl`);
	const save = (id: string, suffix = "") =>
		writeFile(
			file(id),
			`${JSON.stringify({ type: "session", id, cwd, timestamp: "2024-01-01T00:00:00Z" })}\n${suffix}`,
		);
	await save("a");
	await save("b");
	catalog = new SessionCatalog({ sessionsDir: join(root, "sessions"), indexPath: join(root, "index.db") });
	await catalog.refresh();
	await catalog.setArchive({ path: file("b"), archivedAt: 42, archiveRevision: 1 });
	let busy = false;
	let fail = false;
	const remove = vi.fn(async (id: string, path: string) => {
		if (fail && id === "b") throw new Error("transport failed");
		await rm(path);
	});
	const service = new SessionProjectDeletion({
		catalog: () => catalog as SessionCatalog,
		getLoaded: () => [],
		deleteSession: remove,
		isProtected: (path) => path === "/daily",
		isBusy: () => busy,
	});
	return {
		service,
		save,
		file,
		remove,
		setBusy: (value: boolean) => {
			busy = value;
		},
		setFail: (value: boolean) => {
			fail = value;
		},
	};
}

it("counts normal and archived sessions, deletes sequentially and retains failures", async () => {
	const { service, setFail, remove } = await setup();
	const preview = await service.preview(cwd);
	expect(preview).toMatchObject({ sessionCount: 2, archivedCount: 1 });
	setFail(true);
	expect(await service.delete(cwd, preview.token)).toEqual({
		deleted: ["a"],
		failed: [{ sessionId: "b", error: "transport failed" }],
	});
	expect(remove).toHaveBeenCalledTimes(2);
	expect(service.isDeleting(cwd)).toBe(false);
	await expect(service.delete(cwd, preview.token)).rejects.toThrow();
	expect((await service.preview(cwd)).sessionCount).toBe(1);
});

it("rechecks each source after an earlier deletion changes another file", async () => {
	const { save } = await setup();
	const remove = vi.fn(async (id: string) => {
		if (id === "a") await save("b", " ");
	});
	const service = new SessionProjectDeletion({
		catalog: () => catalog as SessionCatalog,
		getLoaded: () => [],
		deleteSession: remove,
		isProtected: () => false,
		isBusy: () => false,
	});
	const preview = await service.preview(cwd);
	const result = await service.delete(cwd, preview.token);
	expect(result.deleted).toEqual(["a"]);
	expect(result.failed[0]?.sessionId).toBe("b");
	expect(remove).toHaveBeenCalledTimes(1);
});

it("releases earlier freezes when a later session cannot be frozen", async () => {
	await setup();
	const release = vi.fn();
	const remove = vi.fn();
	const service = new SessionProjectDeletion({
		catalog: () => catalog as SessionCatalog,
		getLoaded: () => [],
		deleteSession: remove,
		isProtected: () => false,
		isBusy: () => false,
		freeze: (id) => {
			if (id === "b") throw new Error("busy during freeze");
			return release;
		},
	});
	const preview = await service.preview(cwd);
	await expect(service.delete(cwd, preview.token)).rejects.toThrow(/busy during freeze/);
	expect(release).toHaveBeenCalledOnce();
	expect(remove).not.toHaveBeenCalled();
	expect(service.isDeleting(cwd)).toBe(false);
	await expect(service.delete(cwd, preview.token)).rejects.toThrow(/token/);
});

it("rejects duplicate IDs and incomplete scans", async () => {
	const { service, file } = await setup();
	await writeFile(
		file("duplicate"),
		JSON.stringify({ type: "session", id: "a", cwd, timestamp: "2024-01-01T00:00:00Z" }),
	);
	await expect(service.preview(cwd)).rejects.toThrow();
	await writeFile(file("duplicate"), "not a session");
	await expect(service.preview(cwd)).rejects.toThrow(/Incomplete/);
});

it("includes an unsaved loaded session and rejects changed loaded identity", async () => {
	const { file } = await setup();
	let loaded: SessionMeta = {
		sessionId: "empty",
		sessionFile: file("empty"),
		cwd,
		active: true,
		messageCount: 0,
		createdAt: 0,
	};
	const remove = vi.fn(async () => {});
	const service = new SessionProjectDeletion({
		catalog: () => catalog as SessionCatalog,
		getLoaded: () => [loaded],
		deleteSession: remove,
		isProtected: () => false,
		isBusy: () => false,
	});
	const preview = await service.preview(cwd);
	expect(preview.sessionCount).toBe(3);
	loaded = { ...loaded };
	await expect(service.delete(cwd, preview.token)).rejects.toThrow(/changed/);
	const next = await service.preview(cwd);
	const result = await service.delete(cwd, next.token);
	expect(result.deleted).toContain("empty");
	expect(remove).toHaveBeenCalledWith("empty", file("empty"));
});

it("uses stable ownership rather than fresh loaded metadata objects", async () => {
	const { file } = await setup();
	let owner = {};
	const meta: SessionMeta = {
		sessionId: "empty",
		sessionFile: file("empty"),
		cwd,
		active: true,
		messageCount: 0,
		createdAt: 0,
	};
	const service = new SessionProjectDeletion({
		catalog: () => catalog as SessionCatalog,
		getLoaded: () => [{ ...meta }],
		loadedIdentity: () => owner,
		deleteSession: async () => {},
		isProtected: () => false,
		isBusy: () => false,
	});
	const preview = await service.preview(cwd);
	owner = {};
	await expect(service.delete(cwd, preview.token)).rejects.toThrow(/changed/);
	const next = await service.preview(cwd);
	expect((await service.delete(cwd, next.token)).deleted).toContain("empty");
});

it("rejects a confirmation when archive state changes without changing the source", async () => {
	const { service, file, remove } = await setup();
	const preview = await service.preview(cwd);
	await catalog?.setArchive({ path: file("b"), archiveRevision: 2 });
	await expect(service.delete(cwd, preview.token)).rejects.toThrow(/changed/);
	expect(remove).not.toHaveBeenCalled();
});

it("rejects stale additions and modifications, expired tokens and busy sessions", async () => {
	const { service, save, setBusy, remove } = await setup();
	let preview = await service.preview(cwd);
	await save("c");
	await expect(service.delete(cwd, preview.token)).rejects.toThrow();
	preview = await service.preview(cwd);
	await save("a", " ");
	await expect(service.delete(cwd, preview.token)).rejects.toThrow();
	preview = await service.preview(cwd);
	setBusy(true);
	await expect(service.delete(cwd, preview.token)).rejects.toThrow(/busy/);
	setBusy(false);
	preview = await service.preview(cwd);
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001);
	await expect(service.delete(cwd, preview.token)).rejects.toThrow(/expired/);
	expect(remove).not.toHaveBeenCalled();
	await expect(service.preview("relative")).rejects.toThrow();
	await expect(service.preview("/daily")).rejects.toThrow();
});
