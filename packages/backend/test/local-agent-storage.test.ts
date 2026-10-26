import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { environmentEntityKey } from "@percho/shared";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeLocalStorage, inspectLocalStorage, readStorageRecord } from "../src/storage/local-storage";
import {
	assertRemoteStorage,
	inside,
	LOCAL_STORAGE_RECORD,
	type LocalStorageSelection,
	selectLocalStorage,
	validateStorageSelection,
} from "../src/storage/path-policy";
import { migrateNavigation } from "../src/storage/preferences";
import { privateDirectory } from "../src/storage/private-directory";
import { relocateResourceSettings } from "../src/storage/resource-settings";
import { localSessionPaths } from "../src/storage/session-paths";

let home: string, selection: LocalStorageSelection;
const base = resolve(".local/tmp/local-agent-storage-tests");
const mixedState = (extra: Record<string, unknown> = {}) => ({
	version: 1,
	projects: [],
	dailyDirs: [],
	pinnedSessions: [],
	pinnedProjects: [],
	expandedGroups: [],
	expandedGroupsTouched: false,
	lastCwd: null,
	workspace: { members: [], activeFile: null, recentFile: null },
	catalog: [],
	...extra,
});
beforeEach(async () => {
	await mkdir(base, { recursive: true });
	home = await mkdtemp(join(base, "case-迁移-"));
	selection = await validateStorageSelection(selectLocalStorage(home, true, {}));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});
async function seed() {
	const source = selection.source as string;
	await mkdir(join(source, "sessions", "project"), { recursive: true });
	await mkdir(join(source, "sessions-subagents", "project"), { recursive: true });
	await mkdir(join(source, "tmp"), { recursive: true });
	await writeFile(join(source, "auth.json"), '{"fixture":{"type":"api_key","key":"isolated-fixture"}}');
	await writeFile(
		join(source, "settings.json"),
		'{\n // keep this comment\n "extensions": ["' +
			source.replaceAll("\\", "\\\\") +
			'/extensions/tool.ts"], "unknown": {"keep":true}\n}',
	);
	await mkdir(join(source, "extensions"));
	await writeFile(join(source, "extensions", "tool.ts"), "throw Error('must never execute during import')");
	await writeFile(join(source, "package-lock.json"), "fixture lock");
	await writeFile(join(source, "tmp", "notes.txt"), "user notes in cache");
	await writeFile(
		join(source, "sessions", "project", "parent.jsonl"),
		'not valid JSON\n{"type":"session","version":3,"id":"fixture","cwd":"/project"}\n{"unfinished":',
	);
	await writeFile(join(source, "sessions-subagents", "project", "child.jsonl"), "child raw history");
	return source;
}
async function imported() {
	const source = await seed();
	const before = await inspectLocalStorage(selection);
	return { source, record: await initializeLocalStorage(before, "copy") };
}

describe("private directory selection", () => {
	it("rejects old overrides before any mkdir and separates prod/dev/custom", async () => {
		expect(() => selectLocalStorage(home, true, { PI_CODING_AGENT_DIR: "legacy" })).toThrow(
			"PERCHO_LEGACY_AGENT_ENV",
		);
		expect(selectLocalStorage(home, false, {}).target).toBe(join(home, ".percho", "agent-dev"));
		expect(selectLocalStorage(home, true, { PERCHO_AGENT_DIR: "~/isolated" }).source).toBeNull();
		for (const value of ["", " ", "relative"])
			expect(() => selectLocalStorage(home, true, { PERCHO_AGENT_DIR: value })).toThrow();
		expect(await readdir(home)).toEqual([]);
	});
	it("compares path components, including Windows drive aliases", () => {
		expect(inside("C:\\Users\\One\\.pi\\agent", "c:\\users\\one\\.pi\\agent\\sessions\\x", "win32")).toBe(
			true,
		);
		expect(inside("/a/agent", "/a/agent-other")).toBe(false);
		expect(inside("C:\\one", "D:\\two", "win32")).toBe(false);
	});
	it("rejects overlap and a parent link back into Pi", async () => {
		await mkdir(join(home, ".pi"));
		await symlink(
			join(home, ".pi"),
			join(home, ".percho"),
			process.platform === "win32" ? "junction" : undefined,
		);
		await expect(validateStorageSelection(selectLocalStorage(home, true, {}))).rejects.toThrow("overlaps");
	});
	it("does not confuse remote identity or an unreadable identity with no data", async () => {
		await mkdir(selection.target, { recursive: true });
		await writeFile(join(selection.target, "environment.json"), "broken");
		await expect(inspectLocalStorage(selection)).rejects.toThrow("REMOTE_STORAGE");
	});
});

describe("copy, publish, retry", () => {
	it("excludes only an empty SDK authentication lock and rejects unexpected contents", async () => {
		const source = await seed(),
			lock = join(source, "auth.json.lock");
		await mkdir(lock);
		await writeFile(join(lock, "unknown.txt"), "must not disappear");
		await expect(inspectLocalStorage(selection)).rejects.toThrow("Unexpected authentication lock");
		await rm(join(lock, "unknown.txt"));
		await initializeLocalStorage(await inspectLocalStorage(selection), "copy");
		await expect(lstat(join(selection.target, "auth.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(lock)).isDirectory()).toBe(true);
	});
	it("copies history bytes, unknown files, mtime and independent inodes, and preserves JSONC", async () => {
		const source = await seed(),
			before = await readFile(join(source, "settings.json"));
		await writeFile(join(source, "run.sh"), "#!/bin/sh\nexit 0\n");
		await chmod(join(source, "run.sh"), 0o700);
		const inspection = await inspectLocalStorage(selection);
		expect(inspection.state).toBe("import");
		const record = await initializeLocalStorage(inspection, "copy");
		expect(record.kind).toBe("import");
		expect((await inspectLocalStorage(selection)).state).toBe("ready");
		for (const file of [
			"auth.json",
			"sessions/project/parent.jsonl",
			"sessions-subagents/project/child.jsonl",
			"package-lock.json",
			"tmp/notes.txt",
			"run.sh",
		]) {
			expect(await readFile(join(selection.target, file))).toEqual(await readFile(join(source, file)));
			expect(
				Math.abs(
					(await stat(join(selection.target, file))).mtimeMs - (await stat(join(source, file))).mtimeMs,
				),
			).toBeLessThan(2);
			if (process.platform !== "win32")
				expect((await stat(join(selection.target, file))).ino).not.toBe((await stat(join(source, file))).ino);
		}
		expect(await readFile(join(source, "settings.json"))).toEqual(before);
		const settings = await readFile(join(selection.target, "settings.json"), "utf8");
		expect(settings).toContain("keep this comment");
		expect(settings).toContain(selection.target.replaceAll("\\", "\\\\"));
		expect(settings).toContain('"unknown"');
		if (process.platform !== "win32")
			expect((await stat(join(selection.target, "run.sh"))).mode & 0o100).toBe(0o100);
		await privateDirectory(join(selection.target, "auth.json"), false);
		await expect(assertRemoteStorage(selection.target)).rejects.toThrow("LOCAL_STORAGE");
	});
	it("rejects link cycles and unsupported special entries without publishing", async () => {
		const source = await seed(),
			path = join(source, "cycle");
		await symlink(path, path);
		await expect(inspectLocalStorage(selection)).rejects.toThrow();
		await rm(path);
		if (process.platform !== "win32") {
			execFileSync("mkfifo", [join(source, "unknown-pipe")]);
			await expect(inspectLocalStorage(selection)).rejects.toThrow("Unsupported source entry");
		}
		await expect(lstat(selection.target)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("preserves an existing empty/nonempty target and requires explicit adoption", async () => {
		await seed();
		await mkdir(selection.target, { recursive: true, mode: 0o700 });
		await privateDirectory(selection.target, true);
		const i = await inspectLocalStorage(selection);
		expect(i.state).toBe("existing");
		await expect(initializeLocalStorage(i, "copy")).rejects.toThrow("changed");
		await writeFile(join(selection.target, "mine"), "unchanged");
		const r = await initializeLocalStorage(await inspectLocalStorage(selection), "adopt");
		expect(r.kind).toBe("adopt");
		expect(r.sources).toEqual([]);
		expect(await readFile(join(selection.target, "mine"), "utf8")).toBe("unchanged");
	});
	it("starting empty records the decision, without copying credentials", async () => {
		await seed();
		const r = await initializeLocalStorage(await inspectLocalStorage(selection), "empty");
		expect(r.kind).toBe("empty");
		expect(await readdir(selection.target)).toEqual([LOCAL_STORAGE_RECORD]);
		expect((await inspectLocalStorage(selection)).state).toBe("ready");
	});
	it("source changes after confirmation and during copying cannot publish", async () => {
		const source = await seed(),
			first = await inspectLocalStorage(selection);
		await writeFile(join(source, "new-file"), "late");
		await expect(initializeLocalStorage(first, "copy")).rejects.toThrow("Source changed");
		let changed = false;
		await expect(
			initializeLocalStorage(await inspectLocalStorage(selection), "copy", {
				onProgress: (p) => {
					if (p.phase === "copy" && !changed) {
						changed = true;
						writeFileSync(join(source, "auth.json"), "changed during copying");
					}
				},
			}),
		).rejects.toThrow("Source changed");
		await expect(stat(selection.target)).rejects.toHaveProperty("code", "ENOENT");
		expect((await readdir(join(home, ".percho"))).some((p) => p.startsWith(".agent-import-"))).toBe(true);
	});
	it("cancellation retains a recovery copy and retry publishes a fresh one", async () => {
		await seed();
		const abort = new AbortController();
		await expect(
			initializeLocalStorage(await inspectLocalStorage(selection), "copy", {
				signal: abort.signal,
				onProgress: (p) => {
					if (p.phase === "copy") abort.abort();
				},
			}),
		).rejects.toThrow("Recovery copy retained");
		const staged = (await readdir(join(home, ".percho"))).filter((p) => p.startsWith(".agent-import-"));
		expect(staged).toHaveLength(1);
		await initializeLocalStorage(await inspectLocalStorage(selection), "copy");
		expect(await lstat(join(home, ".percho", staged[0] as string))).toBeTruthy();
	});
	it("another migrator cannot publish or replace the chosen target", async () => {
		await seed();
		const i = await inspectLocalStorage(selection);
		let second: Promise<unknown> | undefined;
		const first = initializeLocalStorage(i, "copy", {
			onProgress: (p) => {
				if (p.phase === "copy" && !second) second = initializeLocalStorage(i, "copy").catch((e) => e);
			},
		});
		await first;
		expect(await second).toBeInstanceOf(Error);
	});
	it("a target appearing at publication is not replaced", async () => {
		await seed();
		let appeared = false;
		await expect(
			initializeLocalStorage(await inspectLocalStorage(selection), "copy", {
				onProgress: (p) => {
					if (p.phase === "copy" && !appeared) {
						appeared = true;
						mkdirSync(selection.target, { recursive: true });
						writeFileSync(join(selection.target, "other"), "do not overwrite");
					}
				},
			}),
		).rejects.toThrow("Target appeared");
		expect(await readFile(join(selection.target, "other"), "utf8")).toBe("do not overwrite");
	});
	it("a damaged receipt is not treated as first install", async () => {
		await imported();
		await writeFile(join(selection.target, LOCAL_STORAGE_RECORD), "broken");
		await expect(inspectLocalStorage(selection)).rejects.toThrow();
	});
});

describe("links and resource settings", () => {
	it("rebases internal links but blocks external core links", async () => {
		const source = await seed();
		await symlink(join(source, "extensions", "tool.ts"), join(source, "extensions", "alias.ts"));
		await initializeLocalStorage(await inspectLocalStorage(selection), "copy");
		expect(await readlink(join(selection.target, "extensions", "alias.ts"))).toBe(
			join(selection.target, "extensions", "tool.ts"),
		);
		await rm(selection.target, { recursive: true });
		await rm(join(source, "auth.json"));
		await writeFile(join(home, "external-auth.json"), "{}");
		await symlink(join(home, "external-auth.json"), join(source, "auth.json"));
		await expect(inspectLocalStorage(selection)).rejects.toThrow("Core storage");
	});
	it("lists external resource links before consent and rejects broken links", async () => {
		const source = await seed();
		await writeFile(join(home, "outside.ts"), "fixture");
		await symlink(join(home, "outside.ts"), join(source, "extensions", "outside.ts"));
		expect((await inspectLocalStorage(selection)).external).toContain(join("extensions", "outside.ts"));
		await symlink(join(home, "missing"), join(source, "extensions", "broken"));
		await expect(inspectLocalStorage(selection)).rejects.toThrow();
	});
	it("preserves comments, command strings, npm/git sources and external relative meaning", () => {
		const source = selection.source as string,
			old = source.replaceAll("\\", "\\\\"),
			input = `{ // retained\n"skills":["${old}/skills/a", "../../../outside"],"extensions":["!${old}/extensions/a.ts"],"packages":["npm:fixture","git@github.com:fixture/repo","https://github.com/a/b"],"apiKey":"!cat ${old}/auth.json","unknown":{"x":1}}`;
		const out = relocateResourceSettings(input, {
			source,
			sources: [source],
			target: selection.target,
			home,
			legacyRoots: selection.legacyRoots,
		});
		expect(out.text).toContain("// retained");
		expect(out.text).toContain(`!cat ${old}/auth.json`);
		expect(out.text).toContain("npm:fixture");
		expect(out.text).toContain("git@github.com");
		expect(out.external).toContain("../../../outside");
		expect(out.text).toContain(selection.target.replaceAll("\\", "\\\\"));
	});
});

describe("history references and navigation", () => {
	it("maps old session paths before readonly checks and refuses missing/escaping/unimported files", async () => {
		const { source, record } = await imported(),
			paths = localSessionPaths(record, selection.legacyRoots);
		expect(paths.resolveFile(join(source, "sessions-subagents", "project", "child.jsonl"))).toBe(
			join(selection.target, "sessions-subagents", "project", "child.jsonl"),
		);
		expect(() => paths.resolveFile(join(source, "sessions", "missing.jsonl"))).toThrow();
		expect(() => paths.assertCwd(source)).toThrow("move the project");
		const linkedProject = join(home, "linked-project");
		await symlink(source, linkedProject, process.platform === "win32" ? "junction" : "dir");
		expect(() => paths.assertCwd(linkedProject)).toThrow("move the project");
		const outside = join(home, "outside.jsonl");
		await writeFile(outside, "outside");
		await symlink(outside, join(selection.target, "sessions", "escape.jsonl"));
		expect(() => paths.resolveFile(join(selection.target, "sessions", "escape.jsonl"))).toThrow("escapes");
		expect(() =>
			localSessionPaths({ ...record, kind: "empty", sources: [] }, selection.legacyRoots).resolveFile(
				join(source, "sessions", "project", "parent.jsonl"),
			),
		).toThrow("not imported");
	});
	it("backs up mixed/legacy preferences once, preserves unknown fields and remote values", async () => {
		const { source, record } = await imported(),
			profile = join(home, "profile");
		await mkdir(profile);
		const file = join(source, "sessions", "project", "parent.jsonl"),
			remote =
				"percho-env-v1:%5B%7B%22kind%22%3A%22ssh%22%2C%22connectionId%22%3A%22c%22%2C%22environmentId%22%3A%22e%22%7D%2C%22" +
				encodeURIComponent(file) +
				"%22%5D";
		const legacy = {
			sessionWorkspace: { files: [file], activeFile: file },
			theme: "dark",
			unknown: { keep: true },
		};
		const mixed = mixedState({
			workspace: {
				members: [
					{ file, sessionId: "fixture" },
					{
						file: remote,
						sessionId: environmentEntityKey({ kind: "ssh", connectionId: "c", environmentId: "e" }, "remote"),
					},
				],
				activeFile: file,
				recentFile: remote,
			},
			catalog: [{ sessionId: "fixture", sessionFile: file, cwd: "/project", createdAt: 1, messageCount: 1 }],
			unknown: true,
		});
		await writeFile(join(profile, "ui-state.json"), JSON.stringify(legacy));
		await writeFile(join(profile, "environment-ui-state.json"), JSON.stringify(mixed));
		await migrateNavigation(profile, record);
		await migrateNavigation(profile, record);
		const l = JSON.parse(await readFile(join(profile, "ui-state.json"), "utf8"));
		expect(l.unknown).toEqual({ keep: true });
		expect(l.sessionWorkspace.activeFile).toContain(selection.target);
		const m = JSON.parse(await readFile(join(profile, "environment-ui-state.json"), "utf8"));
		expect(m.workspace.members[1].file).toBe(remote);
		expect(m.catalog[0].cwd).toBe("/project");
		expect(
			JSON.parse(await readFile(join(profile, `ui-state.json.before-agent-import-${record.id}.bak`), "utf8")),
		).toEqual(legacy);
	});
	it("a damaged preference cannot be silently replaced with defaults; published data survive", async () => {
		const { record } = await imported(),
			profile = join(home, "profile");
		await mkdir(profile);
		await writeFile(join(profile, "ui-state.json"), "invalid");
		await expect(migrateNavigation(profile, record)).rejects.toThrow();
		expect(await readFile(join(profile, "ui-state.json"), "utf8")).toBe("invalid");
		expect((await readStorageRecord(selection.target))?.id).toBe(record.id);
	});
});

describe("failure boundaries", () => {
	it("late cancellation at publication cannot publish and retains its copy", async () => {
		await seed();
		const abort = new AbortController();
		await expect(
			initializeLocalStorage(await inspectLocalStorage(selection), "copy", {
				signal: abort.signal,
				onProgress: (p) => {
					if (p.phase === "publish") abort.abort();
				},
			}),
		).rejects.toThrow("Recovery copy retained");
		await expect(stat(selection.target)).rejects.toHaveProperty("code", "ENOENT");
	});
	it("injected disk-full failure leaves the source and recovery copy intact", async () => {
		const source = await seed(),
			original = await readFile(join(source, "auth.json"));
		await expect(
			initializeLocalStorage(await inspectLocalStorage(selection), "copy", {
				onProgress: (p) => {
					if (p.phase === "copy") throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" });
				},
			}),
		).rejects.toThrow("ENOSPC");
		expect(await readFile(join(source, "auth.json"))).toEqual(original);
		await expect(stat(selection.target)).rejects.toHaveProperty("code", "ENOENT");
	});
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"an inaccessible source is not treated as absent",
		async () => {
			await seed();
			const source = selection.source as string;
			await chmod(source, 0);
			try {
				if (process.getuid?.() !== 0)
					await expect(inspectLocalStorage(selection)).rejects.toHaveProperty("code", "EACCES");
			} finally {
				await chmod(source, 0o700);
			}
		},
	);
	it("partial navigation repair can retry without replacing backups or new data", async () => {
		const { source, record } = await imported(),
			profile = join(home, "profile");
		await mkdir(profile);
		const raw = JSON.stringify({
			sessionWorkspace: { files: [join(source, "sessions", "project", "parent.jsonl")], activeFile: null },
			unknown: 9,
		});
		await writeFile(join(profile, "ui-state.json"), raw);
		await writeFile(join(profile, "environment-ui-state.json"), "bad");
		await expect(migrateNavigation(profile, record)).rejects.toThrow();
		const backup = join(profile, `ui-state.json.before-agent-import-${record.id}.bak`);
		expect(await readFile(backup, "utf8")).toBe(raw);
		await writeFile(join(profile, "environment-ui-state.json"), JSON.stringify(mixedState()));
		await migrateNavigation(profile, record);
		expect(await readFile(backup, "utf8")).toBe(raw);
		expect((await readStorageRecord(selection.target))?.id).toBe(record.id);
	});
});

it("an internal settings file link is copied and edited without following a not-yet-published target", async () => {
	const source = await seed();
	await rename(join(source, "settings.json"), join(source, "settings-real.json"));
	await symlink(join(source, "settings-real.json"), join(source, "settings.json"));
	await initializeLocalStorage(await inspectLocalStorage(selection), "copy");
	expect(await readFile(join(selection.target, "settings.json"), "utf8")).toContain(
		selection.target.replaceAll("\\", "\\\\"),
	);
	expect(await readFile(join(source, "settings.json"), "utf8")).toContain(source.replaceAll("\\", "\\\\"));
});
it("adoption rejects a core file still linked to shared credentials", async () => {
	await mkdir(selection.target, { recursive: true, mode: 0o700 });
	await privateDirectory(selection.target, true);
	await writeFile(join(home, "shared-auth"), "{}");
	await symlink(join(home, "shared-auth"), join(selection.target, "auth.json"));
	await expect(initializeLocalStorage(await inspectLocalStorage(selection), "adopt")).rejects.toThrow(
		"Core storage",
	);
	await expect(stat(join(selection.target, LOCAL_STORAGE_RECORD))).rejects.toHaveProperty("code", "ENOENT");
});

it("losing the migration lease stops publication and retains the recovery copy", async () => {
	await seed();
	const original = lockfile.lock.bind(lockfile);
	let compromise: ((error: Error) => void) | undefined, release: (() => Promise<void>) | undefined;
	const spy = vi.spyOn(lockfile, "lock").mockImplementation(async (path, options) => {
		compromise = options?.onCompromised;
		release = await original(path, options);
		return release;
	});
	try {
		await expect(
			initializeLocalStorage(await inspectLocalStorage(selection), "copy", {
				onProgress: (p) => {
					if (p.phase === "copy") compromise?.(new Error("injected lost lease"));
				},
			}),
		).rejects.toThrow("lost its lock");
		await expect(stat(selection.target)).rejects.toHaveProperty("code", "ENOENT");
	} finally {
		await release?.();
		spy.mockRestore();
	}
});
it("an existing prepared history cannot link across parent/child storage roots", async () => {
	await mkdir(join(selection.target, "sessions"), { recursive: true, mode: 0o700 });
	await privateDirectory(selection.target, true);
	await mkdir(join(selection.target, "sessions-subagents"), { mode: 0o700 });
	const child = join(selection.target, "sessions-subagents", "child.jsonl");
	await writeFile(child, "child");
	await symlink(child, join(selection.target, "sessions", "parent-alias.jsonl"));
	await expect(initializeLocalStorage(await inspectLocalStorage(selection), "adopt")).rejects.toThrow(
		"crosses",
	);
});
it("a linked or null storage receipt cannot be adopted or treated as missing", async () => {
	await mkdir(selection.target, { recursive: true, mode: 0o700 });
	await privateDirectory(selection.target, true);
	await writeFile(join(home, "not-a-receipt"), "null");
	await symlink(join(home, "not-a-receipt"), join(selection.target, LOCAL_STORAGE_RECORD));
	await expect(inspectLocalStorage(selection)).rejects.toThrow("record file");
	await rm(join(selection.target, LOCAL_STORAGE_RECORD));
	await writeFile(join(selection.target, LOCAL_STORAGE_RECORD), "null");
	await expect(inspectLocalStorage(selection)).rejects.toThrow("Invalid local storage record");
});
