import { spawn } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";

// Input is JSON on stdin, never interpolated into PowerShell code or interpreted as a command.
const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# A pwsh -> Node -> powershell.exe launch can inherit incompatible PowerShell 7 modules.
# This helper needs only Windows PowerShell's system modules, never user-provided modules.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
$v = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
$p = [string]$v.path
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$a = Get-Acl -LiteralPath $p
if ($v.prepare) {
 $a.SetAccessRuleProtection($true, $false)
 foreach ($r in @($a.Access)) { [void]$a.RemoveAccessRuleSpecific($r) }
 $r = [System.Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $a.AddAccessRule($r)
 Set-Acl -LiteralPath $p -AclObject $a
}
$a = Get-Acl -LiteralPath $p
foreach ($r in $a.Access) {
 if ($r.AccessControlType -eq 'Allow') {
  $sid = $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($sid -notin @($me.Value,'S-1-5-18','S-1-5-32-544')) { throw 'Storage grants another account access. Prepare a private directory before continuing.' }
 }
}
`;
export async function privateDirectory(path: string, prepare: boolean): Promise<void> {
	if (process.platform !== "win32") {
		if (prepare) await chmod(path, 0o700);
		const stat = await lstat(path);
		if (stat.uid !== process.getuid?.() || stat.mode & 0o077)
			throw new Error(`Storage is not private; restrict access before adopting: ${path}`);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-OutputFormat",
				"Text",
				"-EncodedCommand",
				Buffer.from(ACL_SCRIPT, "utf16le").toString("base64"),
			],
			{ stdio: ["pipe", "ignore", "pipe"], windowsHide: true },
		);
		let error = "";
		child.stderr.on("data", (chunk) => {
			if (error.length < 4000) error += String(chunk);
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Storage ACL validation timed out: ${path}`));
		}, 30000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", () => clearTimeout(timer));
		child.stdin.on("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`Cannot verify private storage: ${path}\n${error}`)),
		);
		child.stdin.end(Buffer.from(JSON.stringify({ path, prepare }), "utf8").toString("base64"));
	});
}
