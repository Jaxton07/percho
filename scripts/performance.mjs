#!/usr/bin/env node
import { main } from "./performance/cli.mjs";

// Also applies to owned child scripts which use the platform's default file mode.
process.umask(0o077);
try {
	process.exitCode = await main();
} catch (error) {
	console.error(`Performance tests: ${error.message}`);
	process.exitCode = 2;
}
