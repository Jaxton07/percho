import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

// This bootstrap runs before any SDK import, including when launched from an SSH login shell.
const args = process.argv.slice(2);
const command = args.shift() ?? "status";
let root = join(homedir(), ".percho");
const authArgs =
	command === "auth" ? args.splice(0, args.includes("--root") ? args.indexOf("--root") : args.length) : [];
if (args.length) {
	if (args.length !== 2 || args[0] !== "--root" || !args[1])
		throw new Error("Expected --root <private-directory>");
	root = resolve(args[1]);
}
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_PACKAGE_DIR = resolve(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"..",
);
process.env.PATH = `${join(dirname(fileURLToPath(import.meta.url)), "bin")}${delimiter}${process.env.PATH ?? ""}`;
try {
	const { runRuntimeCli } = await import("./cli.mjs");
	await runRuntimeCli(root, command, authArgs);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
