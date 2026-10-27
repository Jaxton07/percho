import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
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
import lockfile from "proper-lockfile";
import { JsonStore } from "../json-store";
import {
	assertDesktopStorage,
	canonicalPath,
	inside,
	LOCAL_STORAGE_RECORD,
	type LocalStorageSelection,
	statOrMissing,
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
}
export interface StorageProgress {
	phase: "scan" | "copy" | "verify" | "publish" | "preferences";
	files: number;
	bytes: number;
}
export interface StorageInspection {
	selection: LocalStorageSelection;
	state: "ready" | "new" | "import" | "existing";
	record: LocalStorageRecord | null;
	files: number;
	bytes: number;
	external: string[];
	fingerprint?: string;
}
export interface StorageWork {
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
		typeof r.createdAt !== "string" ||
		!Number.isSafeInteger(r.files) ||
		r.files < 0 ||
		!Number.isSafeInteger(r.bytes) ||
		r.bytes < 0
	)
		throw new Error(`Invalid local storage record: ${target}`);
	return r;
}
interface Entry {
	name: string;
	type: "file" | "directory" | "link";
	mode: number;
	mtime: number;
	size: number;
	digest: string;
	link?: string;
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
): Promise<{ entries: Entry[]; external: string[]; files: number; bytes: number }> {
	const root = await realpath(source),
		entries: Entry[] = [],
		external: string[] = [];
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
				const link = await readlink(file),
					destination = await realpath(file);
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
				entries.push({ ...base, type: "link", link: mapped, digest: link });
			} else if (stat.isDirectory()) {
				entries.push({ ...base, type: "directory", digest: "" });
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
	return { entries, external, files, bytes };
}
export async function inspectLocalStorage(
	selection: LocalStorageSelection,
	work: StorageWork = {},
): Promise<StorageInspection> {
	work.signal?.throwIfAborted();
	await assertDesktopStorage(selection.target);
	const stat = await statOrMissing(selection.target);
	if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
		throw new Error(`Storage must be a real directory: ${selection.target}`);
	const record = stat ? await readStorageRecord(selection.target) : null;
	const result = { selection, record, files: 0, bytes: 0, external: [] as string[] };
	if (record) {
		await validateCoreLinks(selection.target);
		await privateDirectory(selection.target, false);
		return { ...result, state: "ready" };
	}
	if (stat) return { ...result, state: "existing" };
	if (!selection.source || !(await statOrMissing(selection.source))) return { ...result, state: "new" };
	await assertDesktopStorage(selection.source);
	const snapshot = await scan(selection.source, selection.target, selection.legacyRoots, work);
	const plan = await settingsPlan(selection, selection.source);
	return {
		...result,
		state: snapshot.entries.length ? "import" : "new",
		...snapshot,
		external: [...snapshot.external, ...(plan?.external ?? [])],
		fingerprint: createHash("sha256").update(JSON.stringify(snapshot.entries)).digest("hex"),
	};
}
async function settingsPlan(selection: LocalStorageSelection, source: string) {
	let path = join(source, "settings.json");
	const stat = await statOrMissing(path);
	if (!stat) return null;
	if (stat.isSymbolicLink() && selection.source && source !== selection.source) {
		const originalRoot = await realpath(selection.source);
		const originalFile = await realpath(join(selection.source, "settings.json"));
		if (!inside(originalRoot, originalFile)) throw new Error("Settings link escapes source storage");
		path = join(source, relative(originalRoot, originalFile));
	}
	return {
		path,
		...relocateResourceSettings(await readFile(path, "utf8"), {
			source: selection.source ?? source,
			sources: [...new Set([selection.source ?? source, await realpath(selection.source ?? source)])],
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
	try {
		const current = await inspectLocalStorage(selection, { signal: work.signal });
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
			sources:
				choice === "copy" && selection.source
					? [...new Set([selection.source, await realpath(selection.source)])]
					: [],
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
			await assertDesktopStorage(target);
			return record;
		}
		staging = join(dirname(target), `.${choice === "copy" ? "agent-import" : "agent-empty"}-${record.id}`);
		await mkdir(staging, { mode: 0o700 });
		await privateDirectory(staging, true);
		if (choice === "copy" && selection.source) {
			const source = await realpath(selection.source),
				before = await scan(source, target, selection.legacyRoots, work);
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
				work.onProgress?.({ phase: "copy", files, bytes });
			}
			work.onProgress?.({ phase: "verify", files, bytes });
			const after = await scan(source, target, selection.legacyRoots, work);
			if (
				(await realpath(selection.source)) !== source ||
				JSON.stringify(before.entries) !== JSON.stringify(after.entries)
			)
				throw new Error("Source changed while copying; close Pi CLI and retry");
			record.files = before.files;
			record.bytes = before.bytes;
			const plan = await settingsPlan(selection, staging);
			if (plan && plan.text !== (await readFile(plan.path, "utf8")))
				await new JsonStore<string>({
					path: plan.path,
					defaultValue: () => "",
					parse: (raw) => raw,
					stringify: (raw) => raw,
					mode: 0o600,
				}).write(plan.text);
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
		return record;
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : error}${staging ? `\nRecovery copy retained: ${staging}` : ""}`,
			{ cause: error },
		);
	} finally {
		if (!compromised) await release();
	}
}
