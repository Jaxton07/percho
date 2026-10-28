/** Test-only marker: distinguish the real SDK CLI child from the short-lived flock helper. */
import { writeFileSync } from "node:fs";

const target = process.env.PERCHO_AUTH_READY_FILE;
if (
	target?.startsWith("/state/t/") &&
	process.argv[1]?.endsWith("/dist/bundle/cli.js") &&
	process.argv.includes("--no-session")
)
	writeFileSync(target, String(process.pid), { mode: 0o600 });
