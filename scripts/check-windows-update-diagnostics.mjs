/** Compile the actual NSIS diagnostic hooks; on Windows execute isolated harnesses.
 * All writes are under .local/tmp; no real installation/uninstallation or registry mutation.
 * The harness alone replaces MessageBox with DetailPrint to avoid blocking CI.
 * The production include retains the stock blocking failure + exit code 2.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Resolve a declared dependency through electron-builder, not an undeclared hoisted package.
const desktopRequire = createRequire(join(root, "packages/desktop/package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"));
const appBuilderPackage = builderRequire.resolve("app-builder-lib/package.json");
const appBuilderRequire = createRequire(appBuilderPackage);
const { getMakeNsisPath } = appBuilderRequire("./out/toolsets/windows.js");
const stock = readFileSync(
	join(dirname(appBuilderPackage), "templates/nsis/include/installUtil.nsh"),
	"utf8",
);
assert.match(stock, /!insertmacro customUnInstallCheck\s+Return/);
assert.match(stock, /!insertmacro customUnInstallCheckCurrentUser\s+Return/);
assert.match(stock, /IfErrors 0 \+3[\s\S]*?SetErrorLevel 2\s+Quit/);
const output = join(root, ".local/tmp/windows-update-hook-check");
mkdirSync(output, { recursive: true });
const actual = readFileSync(join(root, "packages/desktop/build/update-diagnostics.nsh"), "utf8");
assert.match(actual, /MessageBox MB_OK\|MB_ICONEXCLAMATION/);
assert.match(actual, /SetErrorLevel 2\s+Quit/);
assert.ok(
	!actual.includes("$installationDir") && !actual.includes("$uninstallerFileName"),
	"No forward-reference vars from stock uninstallOldVersion allowed",
);
const hook = actual.replace(/^\s*MessageBox MB_OK\|MB_ICONEXCLAMATION (.+)$/m, "        DetailPrint $1");
writeFileSync(join(output, "test-hooks.nsh"), hook);
// Use production's pinned compiler. Windows CI is authoritative; this macOS host's compiler crashes on even a minimal IfErrors script.
const compiler = await getMakeNsisPath();
const flags = ["isUpdated", "isForceRun"]
	.map((name) =>
		[
			`!macro _${name} _a _b _t _f`,
			'  StrCpy $R9 "dirty-flag-scratch"',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal NSIS jump placeholders, not JavaScript.
			'  StrCmp "true" "true" `${_t}` `${_f}`',
			"!macroend",
			`!define ${name} \`"" ${name} ""\``,
		].join("\n"),
	)
	.join("\n");
const nsis = (path) => path.replaceAll("$", () => "$$").replaceAll('"', '$\\"');
const cases = [
	{ name: "success", inputCode: 0, flag: false, exit: 0, current: false },
	{ name: "current-user-pass", inputCode: 0, flag: false, exit: 0, current: true },
	{ name: "launch-error", inputCode: 77, flag: true, exit: 0, current: false },
	{ name: "uninstall-failed", inputCode: 2, flag: false, exit: 2, current: false },
	{ name: "trace-unwritable", inputCode: 0, flag: false, exit: 0, current: false },
];
for (const test of cases) {
	const dir = join(output, test.name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const exe = join(dir, "harness.exe");
	const marker = join(dir, "continued.txt");
	const script = `Unicode true
!include LogicLib.nsh
!define VERSION "diagnostic-harness"
!define INSTALL_REGISTRY_KEY "Software\\Percho-DiagnosticHarness-NotARealInstall"
!define UNINSTALL_REGISTRY_KEY "Software\\Percho-DiagnosticHarness-NotARealInstall"
${flags}
Name "Percho diagnostic harness"
OutFile "${nsis(exe)}"
RequestExecutionLevel user
SilentInstall silent
Var installMode
Var rootKey_uninstallResult
Var expectedErrors
Var actualErrors
LangString uninstallFailed 1033 "Old uninstaller failed"
!include "${nsis(join(output, "test-hooks.nsh"))}"
Function StockReference
  IfErrors 0 +3
    DetailPrint "Not able to launch uninstaller"
    Return
  Return
FunctionEnd
Function Handle
  Exch $rootKey_uninstallResult
  ${test.current ? "!insertmacro customUnInstallCheckCurrentUser" : "!insertmacro customUnInstallCheck"}
  Return
FunctionEnd
Section
  StrCpy $INSTDIR "${nsis(join(dir, "用户"))}"
  StrCpy $installMode "current"
  StrCpy $R9 "sentinel"
  !insertmacro customInit
  ${test.flag ? "SetErrors" : "ClearErrors"}
  Call StockReference
  StrCpy $expectedErrors 0
  IfErrors 0 +2
    StrCpy $expectedErrors 1
  StrCpy $R0 ${test.inputCode}
  ${test.flag ? "SetErrors" : "ClearErrors"}
  Push "${test.current ? "HKEY_CURRENT_USER" : "SHELL_CONTEXT"}"
  Call Handle
  Pop $0
  StrCpy $actualErrors 0
  IfErrors 0 +2
    StrCpy $actualErrors 1
  StrCmp $actualErrors $expectedErrors 0 failed
  StrCmp $R0 ${test.inputCode} 0 failed
  StrCmp $R9 "sentinel" 0 failed
  FileOpen $0 "${nsis(marker)}" w
  FileWrite $0 "continued"
  FileClose $0
  SetErrorLevel 0
  Quit
  failed:
    SetErrorLevel 9
    Quit
SectionEnd
`;
	const source = join(dir, "harness.nsi");
	writeFileSync(source, script);
	const compiled = spawnSync(compiler.path, ["-V2", source], {
		env: { ...process.env, ...compiler.env },
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(compiled.status, 0, compiled.error?.message ?? `${compiled.stdout}\n${compiled.stderr}`);
	console.log(`PASS compile ${test.name}`);
	if (process.platform !== "win32") continue;
	const localAppData = join(dir, "local-app-data");
	if (test.name === "trace-unwritable") writeFileSync(localAppData, "not-a-directory");
	const run = spawnSync(exe, [], {
		env: { ...process.env, LOCALAPPDATA: localAppData },
		timeout: 20_000,
		windowsHide: true,
	});
	assert.equal(run.status, test.exit, run.error?.message ?? `wrong exit for ${test.name}`);
	if (test.exit === 0) assert.equal(readFileSync(marker, "utf8"), "continued");
	if (test.name !== "trace-unwritable") {
		const trace = readFileSync(join(localAppData, "Percho/update-diagnostics/nsis.log"), "utf16le");
		assert.ok(trace.includes(`exit-code=${test.inputCode}`));
		assert.ok(trace.includes("用户"));
		assert.ok(trace.includes("updated=1|force-run=1"));
		assert.ok(trace.includes(`launch-failed=${test.flag ? 1 : 0}`));
	}
	console.log(`PASS execute ${test.name}: exit ${run.status}, stock decision preserved`);
}
if (process.platform === "win32") {
	const collector = readFileSync(
		join(root, "packages/desktop/resources/update-diagnostics/collect.ps1"),
		"utf8",
	);
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", collector], {
		encoding: "utf8",
		timeout: 20_000,
		env: { ...process.env, PERCHO_UPDATE_INSTALL_DIR: output },
	});
	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
	const snapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
	assert.ok(Array.isArray(snapshot.processes));
	assert.ok(Array.isArray(snapshot.uninstallRegistrations));
	assert.ok(snapshot.pathSample.sampledFiles > 0);
	assert.ok(!JSON.stringify(snapshot).includes('"CommandLine"'));
	console.log("PASS read-only PowerShell snapshot / valid UTF-8 JSON");
} else {
	console.log("Windows execution and PowerShell snapshot pending CI (compile-only on this host).");
}
