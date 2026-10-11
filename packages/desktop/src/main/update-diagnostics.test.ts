import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	readDiagnosticTail,
	redactUpdateText,
	redactUpdateValue,
	UpdateDiagnostics,
	type UpdateEnvironment,
} from "./update-diagnostics";

const root = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../.local/tmp/update-diagnostics-test",
);
const directories: string[] = [];
function directory() {
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, "case-"));
	directories.push(dir);
	return dir;
}
function environment(version = "0.6.4"): UpdateEnvironment {
	return {
		version,
		platform: "win32",
		arch: "x64",
		osRelease: "10.0.26300",
		electron: "40.0.0",
		pid: 123,
		executable: "C:\\Users\\用户\\Percho\\Percho.exe",
		installDirectory: "C:\\Users\\用户\\Percho",
		userData: "C:\\Users\\用户\\AppData\\Roaming\\Percho",
		tempDirectory: "C:\\Users\\用户\\AppData\\Local\\Temp",
	};
}
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("update diagnostics", () => {
	it("records environment and a synchronous pre-exit handoff", () => {
		const dir = directory();
		const journal = new UpdateDiagnostics(dir, environment());
		expect(journal.getInfo().previousInstall).toBe("none");
		journal.beginInstall("0.6.5", "explicit");
		const attempt = JSON.parse(readFileSync(join(dir, "install-attempt.json"), "utf8"));
		expect(attempt).toMatchObject({ sourceVersion: "0.6.4", targetVersion: "0.6.5", trigger: "explicit" });
		expect(readFileSync(journal.logPath, "utf8")).toContain("install-handoff-requested");
	});

	it("does not call an old-version restart a confirmed installer failure", () => {
		const dir = directory();
		new UpdateDiagnostics(dir, environment()).beginInstall("0.6.5", "app-quit");
		const restarted = new UpdateDiagnostics(dir, environment());
		expect(restarted.getInfo()).toEqual({ previousInstall: "unconfirmed", targetVersion: "0.6.5" });
		expect(JSON.stringify(restarted.report())).not.toContain('"failed"');
	});

	it("records target running across real journal reload, not just an in-memory flag", () => {
		const dir = directory();
		new UpdateDiagnostics(dir, environment()).beginInstall("0.6.5", "explicit");
		expect(new UpdateDiagnostics(dir, environment("0.6.5")).getInfo().previousInstall).toBe("target-running");
	});

	it("does not treat a different manual upgrade as a failure", () => {
		const dir = directory();
		new UpdateDiagnostics(dir, environment()).beginInstall("0.6.5", "explicit");
		expect(new UpdateDiagnostics(dir, environment("0.6.6")).getInfo().previousInstall).toBe(
			"version-changed",
		);
	});

	it("ignores corrupt and malformed legacy journals without claiming failure", () => {
		for (const content of ["{broken", "null", '{"targetVersion":"0.6.5"}']) {
			const dir = directory();
			writeFileSync(join(dir, "install-attempt.json"), content);
			expect(new UpdateDiagnostics(dir, environment()).getInfo().previousInstall).toBe("none");
		}
	});

	it("keeps the first handoff trigger when before-quit follows explicit install", () => {
		const dir = directory();
		const journal = new UpdateDiagnostics(dir, environment());
		journal.beginInstall("0.6.5", "explicit");
		const first = readFileSync(join(dir, "install-attempt.json"), "utf8");
		journal.beginInstall("0.6.5", "app-quit");
		expect(readFileSync(join(dir, "install-attempt.json"), "utf8")).toBe(first);
	});

	it("diagnostic IO failure cannot break install/download/quit", () => {
		const parent = directory();
		const file = join(parent, "not-a-directory");
		writeFileSync(file, "locked");
		expect(() => {
			const journal = new UpdateDiagnostics(file, environment());
			journal.beginInstall("0.6.5", "explicit");
			journal.record("sdk-error", new Error("example"));
			journal.report();
		}).not.toThrow();
	});

	it("rotates bounded dedicated logs and can export both generations", () => {
		const journal = new UpdateDiagnostics(directory(), environment());
		writeFileSync(journal.logPath, "x".repeat(600_000));
		journal.record("later");
		const report = journal.report() as { logs: { updater: string; updaterPrevious: string } };
		expect(report.logs.updater).toContain("later");
		expect(report.logs.updaterPrevious.length).toBeLessThan(530_000);
		expect(report.logs.updaterPrevious).toContain("truncated");
	});

	it("decodes NSIS UTF-16LE Chinese paths and bounds its tail", () => {
		const path = join(directory(), "nsis.log");
		writeFileSync(path, Buffer.from(`\uFEFF${"长".repeat(400_000)}|exit-code=2|C:\\用户`, "utf16le"));
		const value = readDiagnosticTail(path, "utf16le");
		expect(value).toContain("exit-code=2|C:\\用户");
		expect(value.length).toBeLessThan(270_000);
	});

	it("never exports unrelated app logs, credentials, or conversation files", () => {
		const dir = directory();
		writeFileSync(join(dir, "auth.json"), "DO-NOT-SHARE-AUTH");
		writeFileSync(join(dir, "main.log"), "DO-NOT-SHARE-CHAT");
		const journal = new UpdateDiagnostics(dir, environment());
		journal.record("sdk-info", {
			token: "PRIVATE-TOKEN",
			url: "https://user:secret@host/file?key=PRIVATE-URL#token",
		});
		const serialized = JSON.stringify(journal.report());
		for (const secret of ["DO-NOT-SHARE", "PRIVATE-TOKEN", "PRIVATE-URL", "secret@", "user:"]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("redacts structured secrets and cycles without changing harmless fields", () => {
		const value: Record<string, unknown> = {
			authorization: "Bearer private",
			files: [{ sha512: "integrity" }],
		};
		value.self = value;
		expect(redactUpdateValue(value)).toEqual({
			authorization: "[redacted]",
			files: [{ sha512: "integrity" }],
			self: "[circular]",
		});
		expect(redactUpdateText("Authorization: Bearer private token=private")).not.toContain("private");
	});
});
