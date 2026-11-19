import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
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
import {
	initializeLocalStorage,
	inspectLocalStorage,
	readStorageRecord,
	StorageInitializationError,
} from "../src/storage/local-storage";
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

vi.mock("node:fs", { spy: true });
vi.mock("node:fs/promises", { spy: true });

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
		expect(selectLocalStorage(home, true, {}, true).target).toBe(join(home, ".percho", "agent-beta"));
		expect(selectLocalStorage(home, true, {}, true).source).toBeNull();
		expect(selectLocalStorage(home, true, { PERCHO_AGENT_DIR: "~/isolated" }, true).target).toBe(
			join(home, "isolated"),
		);
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
	it("still offers a choice when source metadata discovery fails after safe path validation", async () => {
		const source = await seed();
		const original = fsPromises.lstat;
		let visits = 0;
		const spy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (path, ...args) => {
			if (path === source && ++visits === 2)
				throw Object.assign(new Error("probe denied"), { code: "EACCES" });
			return original(path, ...args);
		});
		try {
			const probe = await inspectLocalStorage(selection, { scanSource: false });
			expect(probe.state).toBe("candidate");
			await initializeLocalStorage(probe, "empty");
		} finally {
			spy.mockRestore();
		}
	});
	it("preserves copy failure and recovery details if lock release also fails", async () => {
		await seed();
		const preview = await inspectLocalStorage(selection);
		const original = lockfile.lock.bind(lockfile);
		const spy = vi.spyOn(lockfile, "lock").mockImplementation(async (path, options) => {
			const release = await original(path, options);
			return async () => {
				await release();
				throw new Error("release failed");
			};
		});
		try {
			const failure = await initializeLocalStorage(preview, "copy", {
				onProgress: (progress) => {
					if (progress.phase === "copy") throw new Error("copy failed");
				},
			}).catch((error) => error);
			expect(failure).toBeInstanceOf(StorageInitializationError);
			expect(failure.message).toContain("copy failed");
			expect(failure.message).toContain("release failed");
			expect(failure.recoveryPath).toContain(".agent-import-");
			expect(failure.lockReleased).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});
	it("offers a candidate and starts empty without scanning broken source content", async () => {
		const source = selection.source as string;
		await mkdir(join(source, "skills"), { recursive: true });
		await symlink(join(home, "missing"), join(source, "skills", "broken"));
		const reads = vi.spyOn(fsPromises, "readFile");
		const directories = vi.spyOn(fsPromises, "readdir");
		try {
			const inspection = await inspectLocalStorage(selection, { scanSource: false });
			expect(inspection.state).toBe("candidate");
			expect((await initializeLocalStorage(inspection, "empty")).kind).toBe("empty");
			expect(reads.mock.calls.some(([path]) => String(path).startsWith(`${source}/`))).toBe(false);
			expect(directories.mock.calls.some(([path]) => String(path).startsWith(source))).toBe(false);
		} finally {
			reads.mockRestore();
			directories.mockRestore();
		}
	});
	it("does not enumerate or read source content during discovery and locked fresh initialization", async () => {
		const source = await seed();
		const reads = vi.spyOn(fsPromises, "readFile");
		const directories = vi.spyOn(fsPromises, "readdir");
		const streams = vi.spyOn(fs, "createReadStream");
		try {
			const inspection = await inspectLocalStorage(selection, { scanSource: false });
			await initializeLocalStorage(inspection, "empty");
			expect(reads.mock.calls.filter(([path]) => inside(source, String(path)))).toEqual([]);
			expect(directories.mock.calls.filter(([path]) => inside(source, String(path)))).toEqual([]);
			expect(streams.mock.calls.filter(([path]) => inside(source, String(path)))).toEqual([]);
		} finally {
			reads.mockRestore();
			directories.mockRestore();
			streams.mockRestore();
		}
	});
	it.each(["skipped-link", "source-root", "settings"])(
		"rejects changed %s between locked inspection and the snapshot actually copied",
		async (change) => {
			const source = await seed();
			await mkdir(join(source, "skills"));
			await symlink(join(home, "missing"), join(source, "skills", "broken"));
			const preview = await inspectLocalStorage(selection);
			const original = fsPromises.mkdir;
			let changed = false;
			const spy = vi.spyOn(fsPromises, "mkdir").mockImplementation(async (path, ...args) => {
				const result = await original(path, ...args);
				if (!changed && String(path).includes(".agent-import-")) {
					changed = true;
					if (change === "skipped-link") {
						rmSync(join(source, "skills", "broken"));
						symlinkSync(join(home, "another-missing"), join(source, "skills", "broken"));
					} else if (change === "settings") {
						writeFileSync(join(source, "settings.json"), '{"skills":[]}');
					} else {
						renameSync(source, `${source}-previous`);
						fs.cpSync(`${source}-previous`, source, { recursive: true, preserveTimestamps: true });
					}
				}
				return result;
			});
			try {
				await expect(initializeLocalStorage(preview, "copy")).rejects.toThrow("Source changed");
				expect(changed).toBe(true);
				await expect(lstat(selection.target)).rejects.toHaveProperty("code", "ENOENT");
			} finally {
				spy.mockRestore();
			}
		},
	);
	it.runIf(process.platform === "win32")(
		"classifies mixed-case core links and storage markers as private data",
		async () => {
			const source = await seed(),
				outside = join(home, "outside-auth.json");
			await writeFile(outside, "{}");
			await rm(join(source, "auth.json"));
			await symlink(outside, join(source, "AUTH.JSON"));
			await expect(inspectLocalStorage(selection)).rejects.toThrow("Core storage");
			await rm(join(source, "AUTH.JSON"));
			await writeFile(join(source, LOCAL_STORAGE_RECORD.toUpperCase()), "{}");
			await expect(inspectLocalStorage(selection)).rejects.toThrow("existing storage identity");
			await expect(lstat(selection.target)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);
	it.runIf(process.platform === "win32")(
		"refuses adoption when Windows ACL grants another account access",
		async () => {
			await mkdir(selection.target, { recursive: true });
			await privateDirectory(selection.target, true);
			await writeFile(join(selection.target, "sentinel"), "retain existing data");
			execFileSync("icacls.exe", [selection.target, "/grant", "*S-1-1-0:(OI)(CI)(RX)"], { stdio: "pipe" });
			await expect(initializeLocalStorage(await inspectLocalStorage(selection), "adopt")).rejects.toThrow(
				"Storage grants another account access",
			);
			await expect(lstat(join(selection.target, LOCAL_STORAGE_RECORD))).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(await readFile(join(selection.target, "sentinel"), "utf8")).toBe("retain existing data");
		},
		// Two native PowerShell launches plus icacls can exceed the default 5s on a cold Windows runner.
		30000,
	);
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
	it("rejects replacing the source root with identical contents after confirmation", async () => {
		const source = selection.source as string;
		await mkdir(source, { recursive: true });
		const inspection = await inspectLocalStorage(selection);
		await rename(source, `${source}-old`);
		await mkdir(source);
		await expect(initializeLocalStorage(inspection, "copy")).rejects.toThrow("Source changed");
		await expect(lstat(selection.target)).rejects.toHaveProperty("code", "ENOENT");
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
	it("reports the retained staging path as structured recovery data", async () => {
		await seed();
		const inspection = await inspectLocalStorage(selection);
		let failure: unknown;
		try {
			await initializeLocalStorage(inspection, "copy", {
				onProgress: (p) => {
					if (p.phase === "copy") throw new Error("injected failure");
				},
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toHaveProperty("recoveryPath", expect.stringContaining(".agent-import-"));
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
	it.each(["disappear", "replace", "no-inode"])(
		"rejects %s while resolving a broken link",
		async (change) => {
			const source = selection.source as string;
			const link = join(source, "skills", "bad");
			await mkdir(join(source, "skills"), { recursive: true });
			await symlink(join(home, "missing"), link);
			const originalRealpath = fsPromises.realpath;
			const originalLstat = fsPromises.lstat;
			const realpathSpy = vi.spyOn(fsPromises, "realpath").mockImplementation(async (path, ...args) => {
				if (path === link && change !== "no-inode") {
					if (change === "replace") {
						renameSync(link, join(home, "old-link"));
						symlinkSync(join(home, "missing"), link);
					} else rmSync(link);
				}
				return originalRealpath(path, ...args);
			});
			const lstatSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (path, ...args) => {
				const result = await originalLstat(path, ...args);
				if (path === link && change === "no-inode") Object.defineProperty(result, "ino", { value: 0 });
				return result;
			});
			try {
				await expect(inspectLocalStorage(selection)).rejects.toThrow("Source changed");
			} finally {
				realpathSpy.mockRestore();
				lstatSpy.mockRestore();
			}
		},
	);
	it.each(["EACCES", "ELOOP", "ENOTDIR"])("does not suppress %s resolving a resource link", async (code) => {
		const source = selection.source as string;
		const link = join(source, "skills", "bad");
		await mkdir(join(source, "skills"), { recursive: true });
		await symlink(join(home, "missing"), link);
		const original = fsPromises.realpath;
		const spy = vi.spyOn(fsPromises, "realpath").mockImplementation(async (path, ...args) => {
			if (path === link) throw Object.assign(new Error(code), { code });
			return original(path, ...args);
		});
		try {
			await expect(inspectLocalStorage(selection)).rejects.toHaveProperty("code", code);
		} finally {
			spy.mockRestore();
		}
	});
	it.each(["restore", "retarget", "new-broken", "valid-broken", "settings"])(
		"rejects %s after preview and during copy",
		async (change) => {
			for (const duringCopy of [false, true]) {
				const source = selection.source as string;
				await mkdir(join(source, "skills"), { recursive: true });
				await writeFile(join(source, "settings.json"), "{}");
				await writeFile(join(home, "valid"), "valid");
				await symlink(join(home, "missing"), join(source, "skills", "bad"));
				await symlink(join(home, "valid"), join(source, "skills", "valid"));
				const preview = await inspectLocalStorage(selection);
				const mutate = () => {
					if (change === "restore") writeFileSync(join(home, "missing"), "restored");
					if (change === "retarget") {
						rmSync(join(source, "skills", "bad"));
						symlinkSync(join(home, "other-missing"), join(source, "skills", "bad"));
					}
					if (change === "new-broken")
						symlinkSync(join(home, "other-missing"), join(source, "skills", "new"));
					if (change === "valid-broken") rmSync(join(home, "valid"));
					if (change === "settings") writeFileSync(join(source, "settings.json"), '{"skills":[]}');
				};
				if (!duringCopy) mutate();
				let changed = false;
				await expect(
					initializeLocalStorage(preview, "copy", {
						onProgress: (p) => {
							if (duringCopy && !changed && p.phase === "copy") {
								changed = true;
								mutate();
							}
						},
					}),
				).rejects.toThrow("Source changed");
				await expect(lstat(selection.target)).rejects.toHaveProperty("code", "ENOENT");
				await rm(source, { recursive: true, force: true });
				await rm(join(home, "valid"), { force: true });
				await rm(join(home, "missing"), { force: true });
			}
		},
	);
	it("detects link identity changes above the safe integer range", async () => {
		const source = selection.source as string;
		const broken = join(source, "skills", "broken");
		await mkdir(join(source, "skills"), { recursive: true });
		await symlink(join(home, "missing"), broken);
		const original = fsPromises.lstat;
		let visits = 0;
		const spy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (path, ...args) => {
			const stat = await original(path, ...args);
			if (path === broken) {
				const integer = 9007199254740992n + BigInt(visits++ > 1 ? 1 : 0);
				return Object.assign(stat, { ino: typeof stat.ino === "bigint" ? integer : Number(integer) });
			}
			return stat;
		});
		try {
			await expect(inspectLocalStorage(selection)).rejects.toThrow("Source changed");
		} finally {
			spy.mockRestore();
		}
	});
	it("classifies relative to the resolved symlink source root", async () => {
		const source = selection.source as string;
		const actual = join(home, "actual");
		await mkdir(join(actual, "skills"), { recursive: true });
		await mkdir(join(home, ".pi"), { recursive: true });
		await symlink(actual, source, process.platform === "win32" ? "junction" : "dir");
		await symlink(join(home, "missing"), join(actual, "skills", "bad"));
		const preview = await inspectLocalStorage(selection);
		expect(preview.warnings).toEqual([{ path: "skills/bad", reason: "missing-link-target" }]);
		await initializeLocalStorage(preview, "copy");
		expect((await readStorageRecord(selection.target))?.warnings).toEqual(preview.warnings);
	});
	it.runIf(process.platform === "win32")("recognizes mixed-case Skills and broken junctions", async () => {
		const source = selection.source as string;
		await mkdir(join(source, "Skills"), { recursive: true });
		await symlink(join(home, "missing"), join(source, "Skills", "broken"), "junction");
		const preview = await inspectLocalStorage(selection);
		expect(preview.warnings).toEqual([{ path: "Skills/broken", reason: "missing-link-target" }]);
		const record = await initializeLocalStorage(preview, "copy");
		expect((await readStorageRecord(selection.target))?.warnings).toEqual(preview.warnings);
		for (const path of ["skills\\broken", "skills/..\\auth.json", "skills/\\absolute"]) {
			await writeFile(
				join(selection.target, LOCAL_STORAGE_RECORD),
				JSON.stringify({
					...record,
					warnings: [{ path, reason: "missing-link-target" }],
				}),
			);
			await expect(readStorageRecord(selection.target)).rejects.toThrow("Invalid local storage record");
		}
	});
	it.skipIf(process.platform === "win32").each(["skills", "extensions", "prompts", "themes"])(
		"imports %s while preserving literal backslashes in broken link warnings",
		async (resource) => {
			const source = await seed();
			const directory = join(source, resource);
			const missing = join(home, "missing");
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "good.txt"), "keep this resource");
			for (const name of ["..\\auth.json", "bad\\name"]) await symlink(missing, join(directory, name));
			const warnings = [
				{ path: `${resource}/..\\auth.json`, reason: "missing-link-target" },
				{ path: `${resource}/bad\\name`, reason: "missing-link-target" },
			];
			const preview = await inspectLocalStorage(selection);
			expect(preview.warnings).toEqual(warnings);
			await initializeLocalStorage(preview, "copy");
			expect((await readStorageRecord(selection.target))?.warnings).toEqual(warnings);
			expect((await inspectLocalStorage(selection)).state).toBe("ready");
			expect(await readFile(join(selection.target, resource, "good.txt"), "utf8")).toBe("keep this resource");
			for (const name of ["..\\auth.json", "bad\\name"]) {
				expect(await readlink(join(directory, name))).toBe(missing);
				await expect(lstat(join(selection.target, resource, name))).rejects.toHaveProperty("code", "ENOENT");
			}
			expect(await readFile(join(selection.target, "auth.json"), "utf8")).toBe(
				await readFile(join(source, "auth.json"), "utf8"),
			);
		},
	);
	it.each(["skills", "extensions", "prompts", "themes"])(
		"preserves source and imports good content alongside deep broken %s links",
		async (resource) => {
			const source = selection.source as string;
			const dir = join(source, resource, "nested", "deep");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "good"), "content");
			await symlink(
				join(home, "missing"),
				join(dir, "bad"),
				process.platform === "win32" ? "junction" : undefined,
			);
			const inspection = await inspectLocalStorage(selection);
			expect(inspection.warnings).toEqual([
				{ path: `${resource}/nested/deep/bad`, reason: "missing-link-target" },
			]);
			await initializeLocalStorage(inspection, "copy");
			expect((await readStorageRecord(selection.target))?.warnings).toEqual(inspection.warnings);
			expect(await readFile(join(selection.target, resource, "nested", "deep", "good"), "utf8")).toBe(
				"content",
			);
			if (process.platform === "win32") expect((await lstat(join(dir, "bad"))).isSymbolicLink()).toBe(true);
			else expect(await readlink(join(dir, "bad"))).toBe(join(home, "missing"));
			await expect(lstat(join(selection.target, resource, "nested", "deep", "bad"))).rejects.toHaveProperty(
				"code",
				"ENOENT",
			);
		},
	);
	it.each(["unknown/skills", "sessions/skills"])("does not exempt nested %s", async (path) => {
		const source = selection.source as string;
		await mkdir(join(source, path), { recursive: true });
		await symlink(join(home, "missing"), join(source, path, "bad"));
		await expect(inspectLocalStorage(selection)).rejects.toThrow();
	});
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
	it("lists external links and persists skipped broken resource links", async () => {
		const source = await seed();
		await writeFile(join(home, "outside.ts"), "fixture");
		await symlink(join(home, "outside.ts"), join(source, "extensions", "outside.ts"));
		await symlink(join(home, "missing"), join(source, "extensions", "broken"));
		const inspection = await inspectLocalStorage(selection);
		expect(inspection.external).toContain(join("extensions", "outside.ts"));
		expect(inspection.warnings).toEqual([{ path: "extensions/broken", reason: "missing-link-target" }]);
		await initializeLocalStorage(inspection, "copy");
		expect((await readStorageRecord(selection.target))?.warnings).toEqual(inspection.warnings);
		await expect(lstat(join(selection.target, "extensions", "broken"))).rejects.toHaveProperty(
			"code",
			"ENOENT",
		);
	});
	it.each(["skills", "extensions", "prompts", "themes"])(
		"imports with a broken %s root",
		async (resource) => {
			const source = selection.source as string;
			await mkdir(source, { recursive: true });
			await symlink(
				join(home, "missing"),
				join(source, resource),
				process.platform === "win32" ? "junction" : undefined,
			);
			const inspection = await inspectLocalStorage(selection);
			expect(inspection.state).toBe("import");
			expect(inspection.warnings).toEqual([{ path: resource, reason: "missing-link-target" }]);
			await initializeLocalStorage(inspection, "copy");
			expect((await readStorageRecord(selection.target))?.warnings).toEqual(inspection.warnings);
		},
	);
	it("keeps unknown broken links fatal and refuses changed skipped links", async () => {
		const source = selection.source as string;
		await mkdir(join(source, "skills"), { recursive: true });
		await symlink(join(home, "missing"), join(source, "skills", "broken"));
		const inspection = await inspectLocalStorage(selection);
		await rm(join(source, "skills", "broken"));
		await expect(initializeLocalStorage(inspection, "copy")).rejects.toThrow("Source changed");
		await symlink(join(home, "missing"), join(source, "unknown"));
		await expect(inspectLocalStorage(selection)).rejects.toThrow();
	});
	it("rejects malformed or non-import warning records", async () => {
		const { record } = await imported();
		const marker = join(selection.target, LOCAL_STORAGE_RECORD);
		for (const warnings of [
			null,
			[{ path: "../skills/x", reason: "missing-link-target" }],
			[{ path: "skills/x", reason: "unknown" }],
			[
				{ path: "skills/x", reason: "missing-link-target" },
				{ path: "skills/x", reason: "missing-link-target" },
			],
		]) {
			await writeFile(marker, JSON.stringify({ ...record, warnings }));
			await expect(readStorageRecord(selection.target)).rejects.toThrow("Invalid local storage record");
		}
		await writeFile(marker, JSON.stringify({ ...record, kind: "empty", sources: [], warnings: [] }));
		await expect(readStorageRecord(selection.target)).rejects.toThrow("Invalid local storage record");
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
			remote = environmentEntityKey({ kind: "ssh", connectionId: "c", environmentId: "e" }, file);
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
	let injected = false;
	const spy = vi.spyOn(lockfile, "lock").mockImplementation(async (path, options) => {
		compromise = options?.onCompromised;
		release = await original(path, options);
		return release;
	});
	try {
		await expect(
			initializeLocalStorage(await inspectLocalStorage(selection), "copy", {
				onProgress: (p) => {
					if (p.phase === "copy") {
						injected = true;
						compromise?.(new Error("injected lost lease"));
					}
				},
			}),
		).rejects.toThrow("lost its lock");
		await expect(stat(selection.target)).rejects.toHaveProperty("code", "ENOENT");
	} finally {
		if (injected) await release?.();
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
