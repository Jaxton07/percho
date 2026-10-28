import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { SshPreflight } from "@percho/shared";
import { INSTALL_SCRIPT } from "./install-script";
import { sshArguments } from "./ssh-arguments";
import { checkSshRequirements, preflightSsh, shellQuote } from "./ssh-preflight";

export async function installSshRuntime(
	probe: SshPreflight,
	archive: string,
	metadata: { releaseId: string; arch: string; bytes: number; sha256: string; protocol: number },
	signal: AbortSignal,
): Promise<void> {
	const fresh = await preflightSsh(probe.alias, signal);
	checkSshRequirements(fresh);
	const identity = (value: SshPreflight) =>
		JSON.stringify([
			value.target,
			value.uid,
			value.home,
			value.node,
			value.nodeVersion,
			value.agentDir,
			value.environmentId,
		]);
	if (identity(probe) !== identity(fresh)) throw new Error("Remote identity changed before installation");
	if (fresh.serviceState !== "stopped")
		throw new Error("Explicitly stop the remote service and verify ownership release before installation");
	const child = spawn(
		"ssh",
		sshArguments(
			probe.alias,
			`exec ${shellQuote(probe.node)} -e ${shellQuote(INSTALL_SCRIPT)} ${shellQuote(JSON.stringify(metadata))}`,
		),
		{
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			signal,
		},
	);
	let output = "",
		stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(0, 16384);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(0, 16384);
	});
	const timer = setTimeout(() => child.kill(), 180_000);
	try {
		const closed = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0
					? resolve()
					: reject(
							new Error(stderr.trim() || "SSH installation interrupted; check the target before retrying"),
						),
			);
		});
		const upload = pipeline(createReadStream(archive), child.stdin).catch((error: unknown) => error);
		const [uploadError] = await Promise.all([upload, closed]);
		if (uploadError) throw uploadError;
		const result = JSON.parse(output);
		if (result.installed !== true || result.sha256 !== metadata.sha256)
			throw new Error("Remote installation result is unconfirmed");
	} finally {
		clearTimeout(timer);
		child.kill();
	}
}
