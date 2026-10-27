import { constants } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { environmentEntityRef, parseEnvironmentUiState } from "@percho/shared";
import { JsonStore } from "../json-store";
import type { LocalStorageRecord } from "./local-storage";
import { statOrMissing } from "./path-policy";
import { mappedStoragePath } from "./session-paths";

type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function mapIdentity(value: unknown, record: LocalStorageRecord): unknown {
	if (typeof value !== "string") return value;
	// Remote envelopes must remain byte-identical, even when their literal path matches the local source.
	const ref = environmentEntityRef(value);
	if (ref.environment.kind !== "local") return value;
	return mappedStoragePath(value, record);
}
export function mapNavigation(raw: unknown, record: LocalStorageRecord, mixed: boolean): unknown {
	if (!object(raw)) throw new Error("Navigation preferences must be an object");
	if (mixed && !parseEnvironmentUiState(raw))
		throw new Error("Invalid mixed navigation preferences; original retained");
	if (!mixed && raw.sessionWorkspace !== undefined) {
		const w = raw.sessionWorkspace;
		if (
			!object(w) ||
			!Array.isArray(w.files) ||
			w.files.some((value) => typeof value !== "string") ||
			(w.activeFile !== null && typeof w.activeFile !== "string")
		)
			throw new Error("Invalid legacy workspace preferences; original retained");
	}
	const out = structuredClone(raw),
		map = (v: unknown) => mapIdentity(v, record);
	if (mixed) {
		// Project cwd/daily directories stay in place; only session files are relocated.
		if (object(out.workspace)) {
			const w = out.workspace;
			for (const key of ["activeFile", "recentFile"]) if (w[key] != null) w[key] = map(w[key]);
			if (Array.isArray(w.members))
				for (const member of w.members)
					if (object(member) && "file" in member) member.file = map(member.file);
		}
		if (Array.isArray(out.catalog))
			for (const meta of out.catalog)
				if (object(meta) && "sessionFile" in meta) meta.sessionFile = map(meta.sessionFile);
	} else {
		if (object(out.sessionWorkspace)) {
			const w = out.sessionWorkspace;
			if (Array.isArray(w.files)) w.files = w.files.map(map);
			if (w.activeFile != null) w.activeFile = map(w.activeFile);
		}
	}
	return out;
}
/** Strict read + exclusive original backup before any JsonStore update. No default-and-save path. */
export async function migrateNavigation(userData: string, record: LocalStorageRecord): Promise<void> {
	if (record.kind !== "import") return;
	for (const name of ["ui-state.json", "environment-ui-state.json"]) {
		const path = join(userData, name);
		if (!(await statOrMissing(path))) continue;
		const raw = await readFile(path, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`Cannot parse preferences; original retained: ${path}`);
		}
		const converted = mapNavigation(parsed, record, name === "environment-ui-state.json");
		if (JSON.stringify(converted) === JSON.stringify(parsed)) continue;
		const backup = `${path}.before-agent-import-${record.id}.bak`;
		try {
			await copyFile(path, backup, constants.COPYFILE_EXCL);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		await new JsonStore<unknown>({
			path,
			defaultValue: () => {
				throw new Error(`Preferences disappeared: ${path}`);
			},
		}).update((value) => mapNavigation(value, record, name === "environment-ui-state.json"));
	}
}
