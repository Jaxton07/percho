/** A concrete configured Host alias, never a destination expression or remote command supplied by renderer. */
export function validateSshAlias(alias: string): string {
	if (typeof alias !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(alias))
		throw new Error("Enter a concrete SSH Host alias");
	return alias;
}
export function sshArguments(alias: string, command: string): string[] {
	return [
		"-T",
		"-oBatchMode=yes",
		"-oStrictHostKeyChecking=yes",
		"-oForwardAgent=no",
		"-oClearAllForwardings=yes",
		"-oControlMaster=no",
		"-oControlPath=none",
		"-oConnectTimeout=10",
		"-oServerAliveInterval=5",
		"-oServerAliveCountMax=3",
		"--",
		validateSshAlias(alias),
		command,
	];
}
