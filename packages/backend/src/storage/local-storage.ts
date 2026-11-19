import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
	stat as followStat,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	symlink,
	utimes,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { StorageMigrationWarning } from "@percho/shared";
import lockfile from "proper-lockfile";
import { JsonStore } from "../json-store";
import {
	assertDesktopStorage,
	canonicalPath,
	inside,
	LOCAL_STORAGE_RECORD,
	type LocalStorageSelection,
	statOrMissing,
	validateStorageSelection,
} from "./path-policy";
import { privateDirectory } from "./private-directory";
import { relocateResourceSettings } from "./resource-settings";

export interface LocalStorageRecord {
	version: 1;
	id: string;
	kind: "import" | "empty" | "adopt";
	target: string;
	sources: string[];
	createdAt: string;
	files: number;
	bytes: number;
	warnings?: StorageMigrationWarning[];
}
export class StorageInitializationError extends Error {
	constructor(
		message: string,
		public readonly recoveryPath: string | undefined,
		cause: unknown,
		public readonly lockReleased = true,
	) {
		super(message, { cause });
		this.name = "StorageInitializationError";
	}
}
export interface StorageProgress {
	phase: "scan" | "copy" | "verify" | "publish" | "preferences";
	files: number;
	bytes: number;
	totalFiles?: number;
	totalBytes?: number;
}
export interface StorageInspection {
	selection: LocalStorageSelection;
	state: "ready" | "new" | "candidate" | "import" | "existing";
	record: LocalStorageRecord | null;
	files: number;
	bytes: number;
	external: string[];
	warnings: StorageMigrationWarning[];
	fingerprint?: string;
}
export interface StorageWork {
	scanSource?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: StorageProgress) => void;
}
export async function readStorageRecord(target: string): Promise<LocalStorageRecord | null> {
	const markerPath = join(target, LOCAL_STORAGE_RECORD);
	const markerStat = await statOrMissing(markerPath);
	if (markerStat && (!markerStat.isFile() || markerStat.isSymbolicLink()))
		throw new Error(`Invalid storage record file: ${markerPath}`);
	let raw: string;
	try {
		raw = await readFile(join(target, LOCAL_STORAGE_RECORD), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let r: LocalStorageRecord;
	try {
		r = JSON.parse(raw) as LocalStorageRecord;
	} catch {
		throw new Error(`Cannot parse local storage record: ${markerPath}`);
	}
	if (
		!r ||
		typeof r !== "object" ||
		r.version !== 1 ||
		!["import", "empty", "adopt"].includes(r.kind) ||
		typeof r.id !== "string" ||
		!/^[\da-f-]{36}$/.test(r.id) ||
		typeof r.target !== "string" ||
		resolve(r.target) !== resolve(target) ||
		!Array.isArray(r.sources) ||
		r.sources.some(
			(s) => typeof s !== "string" || !isAbsolute(s) || inside(s, target) || inside(target, s),
		) ||
		(r.kind !== "import" && r.sources.length !== 0) ||
		(r.kind === "import" && r.sources.length === 0) ||
		(r.warnings !== undefined && (r.kind !== "import" || !validWarnings(r.warnings))) ||
		typeof r.createdAt !== "string" ||
		!Number.isSafeInteger(r.files) ||
		r.files < 0 ||
		!Number.isSafeInteger(r.bytes) ||
		r.bytes < 0
	)
		throw new Error(`Invalid local storage record: ${target}`);
	return r;
}
const OPTIONAL_RESOURCES = new Set(["skills", "extensions", "prompts", "themes"]);
function validWarnings(warnings: unknown): warnings is StorageMigrationWarning[] {
	if (!Array.isArray(warnings)) return false;
	let previous: string | undefined;
	for (const warning of warnings) {
		if (
			!warning ||
			typeof warning !== "object" ||
			Object.keys(warning).sort().join(",") !== "path,reason" ||
			typeof warning.path !== "string" ||
			warning.reason !== "missing-link-target" ||
			(process.platform === "win32" && warning.path.includes("\\")) ||
			isAbsolute(warning.path) ||
			/^[A-Za-z]:/.test(warning.path)
		)
			return false;
		const parts = warning.path.split("/");
		const first = process.platform === "win32" ? parts[0]?.toLowerCase() : parts[0];
		if (
			!first ||
			!OPTIONAL_RESOURCES.has(first) ||
			parts.some((p: string) => !p || p === "." || p === "..") ||
			(previous !== undefined && previous >= warning.path)
		)
			return false;
		previous = warning.path;
	}
	return true;
}
function identity(stat: BigIntStats, link = false) {
	// Keep native file IDs and nanosecond timestamps lossless on Windows as well as POSIX.
	const fields = link
		? [stat.dev, stat.ino, stat.mode, stat.size, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs]
		: [stat.dev, stat.ino, stat.mode, stat.birthtimeNs];
	return fields.map((value) => value.toString());
}
interface SkippedLink {
	path: string;
	link: string;
	identity: string[];
}
interface Entry {
	name: string;
	type: "file" | "directory" | "link";
	mode: number;
	mtime: number;
	size: number;
	digest: string;
	link?: string;
	identity?: string[];
}
async function digest(path: string, signal?: AbortSignal) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
	return hash.digest("hex");
}
const CORE = new Set([
	"auth.json",
	"models.json",
	"settings.json",
	"mcp.json",
	"permissions.json",
	"trust.json",
	"workspaces.json",
	"model-prefs.json",
]);
async function validateCoreLinks(agent: string, recursive = false): Promise<void> {
	const root = await realpath(agent);
	for (const name of [...CORE, "sessions", "sessions-subagents"]) {
		const path = join(agent, name),
			stat = await statOrMissing(path);
		if (!stat) continue;
		const session = name === "sessions" || name === "sessions-subagents";
		if (stat.isSymbolicLink() && (session || !inside(root, await realpath(path))))
			throw new Error(`Core storage cannot retain this link: ${path}`);
		if (recursive && session && stat.isDirectory()) {
			const walk = async (dir: string): Promise<void> => {
				for (const e of await readdir(dir, { withFileTypes: true })) {
					const file = join(dir, e.name);
					if (e.isSymbolicLink()) {
						if (!inside(path, await realpath(file)))
							throw new Error(`Session link crosses its private history root: ${file}`);
					} else if (e.isDirectory()) await walk(file);
				}
			};
			await walk(path);
		}
	}
}
async function scan(
	source: string,
	target: string,
	legacyRoots: string[],
	work: StorageWork,
): Promise<{
	entries: Entry[];
	external: string[];
	warnings: StorageMigrationWarning[];
	skipped: SkippedLink[];
	files: number;
	bytes: number;
}> {
	const root = await realpath(source),
		entries: Entry[] = [],
		external: string[] = [],
		warnings: StorageMigrationWarning[] = [],
		skipped: SkippedLink[] = [];
	let files = 0,
		bytes = 0;
	async function visit(dir: string) {
		work.signal?.throwIfAborted();
		for (const item of (await readdir(dir)).sort()) {
			const file = join(dir, item),
				name = relative(root, file),
				key = process.platform === "win32" ? name.toLowerCase() : name,
				stat = await statOrMissing(file);
			if (!stat) throw new Error(`Source changed: ${file}`);
			// proper-lockfile's exact transient auth lock directory, not arbitrary *.lock files.
			if (key === "auth.json.lock" && stat.isDirectory()) {
				if ((await readdir(file)).length) throw new Error(`Unexpected authentication lock contents: ${file}`);
				continue;
			}
			if (key === LOCAL_STORAGE_RECORD || key === "environment.json")
				throw new Error(`Source has an existing storage identity: ${file}`);
			const base = { name, mode: stat.mode, mtime: stat.mtimeMs, size: stat.size };
			if (stat.isSymbolicLink()) {
				if (key === "sessions" || key === "sessions-subagents")
					throw new Error(`Session roots must be ordinary directories: ${file}`);
				const linkStat = await lstat(file, { bigint: true });
				if (!linkStat.isSymbolicLink()) throw new Error(`Source changed: ${file}`);
				const link = await readlink(file);
				let destination: string;
				try {
					destination = await realpath(file);
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code !== "ENOENT" ||
						!OPTIONAL_RESOURCES.has(key.split(sep)[0] ?? "")
					)
						throw error;
					const again = await lstat(file, { bigint: true }).catch((cause) => {
						throw new Error(`Source changed: ${file}`, { cause });
					});
					if (
						!again.isSymbolicLink() ||
						!linkStat.ino ||
						!again.ino ||
						JSON.stringify(identity(linkStat, true)) !== JSON.stringify(identity(again, true)) ||
						(await readlink(file)) !== link
					)
						throw new Error(`Source changed: ${file}`);
					const path = name.split(sep).join("/");
					warnings.push({ path, reason: "missing-link-target" });
					skipped.push({ path, link, identity: identity(linkStat, true) });
					continue;
				}
				if (!inside(root, destination)) {
					if (
						CORE.has(key) ||
						key
							.split(sep)
							.some((part, index) => index === 0 && ["sessions", "sessions-subagents"].includes(part))
					)
						throw new Error(`Core storage cannot use an external link: ${file}`);
					if (legacyRoots.some((old) => inside(old, destination)))
						throw new Error(`External link points to Pi data: ${file}`);
					external.push(name);
				}
				const section = key.split(sep)[0] ?? "";
				if (["sessions", "sessions-subagents"].includes(section) && !inside(join(root, section), destination))
					throw new Error(`Session link crosses its private history root: ${file}`);
				const mapped = inside(root, destination) ? join(target, relative(root, destination)) : destination;
				entries.push({
					...base,
					type: "link",
					link: mapped,
					digest: link,
					identity: identity(linkStat, true),
				});
			} else if (stat.isDirectory()) {
				entries.push({ ...base, mtime: 0, size: 0, type: "directory", digest: "" });
				await visit(file);
			} else if (stat.isFile()) {
				entries.push({ ...base, type: "file", digest: await digest(file, work.signal) });
				files++;
				bytes += stat.size;
			} else throw new Error(`Unsupported source entry: ${file}`);
			work.onProgress?.({ phase: "scan", files, bytes });
		}
	}
	await visit(root);
	warnings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (!validWarnings(warnings)) throw new Error("Cannot represent migration warning path");
	skipped.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return { entries, external, warnings, skipped, files, bytes };
}
export async function inspectLocalStorage(
	selection: LocalStorageSelection,
	work: StorageWork = {},
): Promise<StorageInspection> {
	work.signal?.throwIfAborted();
	const validated = await validateStorageSelection(selection);
	if (validated.target !== selection.target) throw new Error("Storage path changed; inspect it again");
	await assertDesktopStorage(selection.target);
	const stat = await statOrMissing(selection.target);
	if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
		throw new Error(`Storage must be a real directory: ${selection.target}`);
	const record = stat ? await readStorageRecord(selection.target) : null;
	const result = {
		selection,
		record,
		files: 0,
		bytes: 0,
		external: [] as string[],
		warnings: [] as StorageMigrationWarning[],
	};
	if (record) {
		await validateCoreLinks(selection.target);
		await privateDirectory(selection.target, false);
		return { ...result, state: "ready" };
	}
	if (stat) return { ...result, state: "existing" };
	if (!selection.source) return { ...result, state: "new" };
	try {
		if (!(await statOrMissing(selection.source))) return { ...result, state: "new" };
	} catch (error) {
		// Isolation has already been verified. Uncertain discovery still requires a user choice.
		if (work.scanSource !== false) throw error;
		return { ...result, state: "candidate" };
	}
	if (work.scanSource === false) return { ...result, state: "candidate" };
	await assertDesktopStorage(selection.source);
	const snapshot = await fullSnapshot(selection, work);
	return {
		...result,
		state: "import",
		...snapshot,
		fingerprint: fingerprint(snapshot),
	};
}
async function fullSnapshot(selection: LocalStorageSelection, work: StorageWork) {
	const source = selection.source as string;
	const rootLink = await lstat(source, { bigint: true });
	const root = await realpath(source);
	const rootStat = await followStat(root, { bigint: true });
	const rootIdentity = {
		root,
		link: rootLink.isSymbolicLink() ? [identity(rootLink, true), await readlink(source)] : null,
		directory: identity(rootStat),
	};
	const snapshot = await scan(root, selection.target, selection.legacyRoots, work);
	const plan = await settingsPlan(selection, root);
	return {
		...snapshot,
		external: [...snapshot.external, ...(plan?.external ?? [])],
		rootIdentity,
		settings: plan,
	};
}
function fingerprint(snapshot: Awaited<ReturnType<typeof fullSnapshot>>) {
	return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
async function settingsPlan(selection: LocalStorageSelection, source: string) {
	let path = join(source, "settings.json");
	const stat = await statOrMissing(path);
	if (!stat) return null;
	if (stat.isSymbolicLink()) {
		path = await realpath(path);
		if (!inside(source, path)) throw new Error("Settings link escapes source storage");
	}
	return {
		path,
		...relocateResourceSettings(await readFile(path, "utf8"), {
			source: selection.source ?? source,
			sources: [...new Set([selection.source ?? source, source])],
			target: selection.target,
			home: selection.home,
			legacyRoots: selection.legacyRoots,
		}),
	};
}
export async function initializeLocalStorage(
	inspection: StorageInspection,
	choice: "copy" | "empty" | "adopt",
	work: StorageWork = {},
): Promise<LocalStorageRecord> {
	const { selection } = inspection,
		target = selection.target;
	await mkdir(dirname(target), { recursive: true });
	let compromised = false;
	const release = await lockfile.lock(target, {
		realpath: false,
		retries: 0,
		onCompromised: () => {
			compromised = true;
		},
	});
	const check = () => {
		work.signal?.throwIfAborted();
		if (compromised) throw new Error("Storage migration lost its lock");
	};
	let staging: string | undefined;
	let published = false;
	const prepare = async () => {
		const current = await inspectLocalStorage(selection, {
			signal: work.signal,
			scanSource: choice === "copy",
		});
		if (current.record) throw new Error("Storage changed; inspect it again before choosing");
		if (
			choice === "copy" &&
			(inspection.fingerprint !== current.fingerprint ||
				JSON.stringify(inspection.external) !== JSON.stringify(current.external))
		)
			throw new Error("Source changed since confirmation; inspect it again");
		if ((current.state === "existing") !== (choice === "adopt"))
			throw new Error("Storage changed; inspect it again before choosing");
		if (choice === "copy" && current.state !== "import") throw new Error("No legacy source available");
		const record: LocalStorageRecord = {
			version: 1,
			id: randomUUID(),
			kind: choice === "copy" ? "import" : choice,
			target,
			sources: [],
			createdAt: new Date().toISOString(),
			files: 0,
			bytes: 0,
		};
		check();
		if (choice === "adopt") {
			await assertDesktopStorage(target);
			await privateDirectory(target, false);
			await validateCoreLinks(target, true);
			await new JsonStore({
				path: join(target, LOCAL_STORAGE_RECORD),
				defaultValue: () => record,
				mode: 0o600,
			}).update((value) => value);
			published = true;
			await assertDesktopStorage(target);
			return record;
		}
		staging = join(dirname(target), `.${choice === "copy" ? "agent-import" : "agent-empty"}-${record.id}`);
		await mkdir(staging, { mode: 0o700 });
		await privateDirectory(staging, true);
		if (choice === "copy" && selection.source) {
			const before = await fullSnapshot(selection, work),
				source = before.rootIdentity.root;
			if (fingerprint(before) !== inspection.fingerprint)
				throw new Error("Source changed since confirmation; inspect it again");
			record.sources = [...new Set([selection.source, source])];
			record.warnings = before.warnings;
			let files = 0,
				bytes = 0;
			for (const entry of before.entries) {
				check();
				const file = join(staging, entry.name),
					input = join(source, entry.name);
				if (entry.type === "directory") await mkdir(file, { mode: 0o700 });
				else if (entry.type === "link")
					await symlink(
						entry.link as string,
						file,
						process.platform === "win32" && (await statOrMissing(await realpath(input)))?.isDirectory()
							? "junction"
							: undefined,
					);
				else {
					await pipeline(createReadStream(input), createWriteStream(file, { flags: "wx", mode: 0o600 }), {
						signal: work.signal,
					});
					await chmod(file, 0o600 | (entry.mode & 0o100));
					await utimes(file, entry.mtime / 1000, entry.mtime / 1000);
					if ((await digest(file, work.signal)) !== entry.digest)
						throw new Error(`Copy verification failed: ${input}`);
					files++;
					bytes += entry.size;
				}
				work.onProgress?.({
					phase: "copy",
					files,
					bytes,
					totalFiles: before.files,
					totalBytes: before.bytes,
				});
			}
			work.onProgress?.({ phase: "verify", files, bytes });
			const after = await fullSnapshot(selection, {
				...work,
				onProgress: (progress) => work.onProgress?.({ ...progress, phase: "verify" }),
			});
			if (fingerprint(after) !== inspection.fingerprint)
				throw new Error("Source changed while copying; close Pi CLI and retry");
			record.files = before.files;
			record.bytes = before.bytes;
			const plan = before.settings;
			if (plan) {
				const settingsPath = join(staging, relative(source, plan.path));
				if (plan.text !== (await readFile(settingsPath, "utf8")))
					await new JsonStore<string>({
						path: settingsPath,
						defaultValue: () => "",
						parse: (raw) => raw,
						stringify: (raw) => raw,
						mode: 0o600,
					}).write(plan.text);
			}
		}
		check();
		await new JsonStore({
			path: join(staging, LOCAL_STORAGE_RECORD),
			defaultValue: () => record,
			mode: 0o600,
		}).write(record);
		// Windows FlushFileBuffers requires a writable handle; r+ never truncates the record.
		const marker = await open(join(staging, LOCAL_STORAGE_RECORD), "r+");
		try {
			await marker.sync();
		} finally {
			await marker.close();
		}
		check();
		if (await statOrMissing(target)) throw new Error(`Target appeared during import: ${target}`);
		work.onProgress?.({ phase: "publish", files: record.files, bytes: record.bytes });
		check();
		if ((await canonicalPath(target)) !== target || (await statOrMissing(target)))
			throw new Error(`Target appeared or changed during import: ${target}`);
		await rename(staging, target);
		published = true;
		return record;
	};
	let outcome: { record: LocalStorageRecord } | { error: StorageInitializationError };
	try {
		outcome = { record: await prepare() };
	} catch (error) {
		const recoveryPath = published ? undefined : staging;
		outcome = {
			error: new StorageInitializationError(
				`${error instanceof Error ? error.message : error}${recoveryPath ? `\nRecovery copy retained: ${recoveryPath}` : ""}`,
				recoveryPath,
				error,
				!compromised,
			),
		};
	}
	if (!compromised) {
		try {
			await release();
		} catch (error) {
			const failure = "error" in outcome ? outcome.error : undefined;
			throw new StorageInitializationError(
				`${failure ? `${failure.message}\n` : ""}Cannot release storage lock: ${error instanceof Error ? error.message : error}`,
				published ? undefined : staging,
				new AggregateError(failure ? [failure, error] : [error], "Storage lock release failed"),
				false,
			);
		}
	}
	if ("error" in outcome) throw outcome.error;
	return outcome.record;
}
