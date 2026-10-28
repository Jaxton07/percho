/** Private path refusal using the actual package, only inside disposable root-owned Linux containers. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, chown, mkdir, symlink } from "node:fs/promises";
import { promisify } from "node:util";

const entry = process.env.PERCHO_RUNTIME_TEST_ENTRY;
if (process.platform !== "linux" || entry !== "/runtime/entry.mjs" || process.getuid() !== 0)
	throw new Error("Isolated root-owned artifact container required");
const exec = promisify(execFile);
const check = (root) => exec(process.execPath, [entry, "start", "--root", root], { timeout: 15000 });
await mkdir("/state/unsafe-mode", { mode: 0o700 });
await chmod("/state/unsafe-mode", 0o755);
await assert.rejects(check("/state/unsafe-mode"), /owned by the current user with mode 0700/);
await mkdir("/state/unsafe-owner", { mode: 0o700 });
await chown("/state/unsafe-owner", 12345, 12345);
await assert.rejects(check("/state/unsafe-owner"), /owned by the current user with mode 0700/);
await mkdir("/state/link-target", { mode: 0o700 });
await symlink("/state/link-target", "/state/symlink-root");
await assert.rejects(check("/state/symlink-root"), /owned by the current user with mode 0700/);
const longRoot = `/state/${"p".repeat(105)}`;
await mkdir(longRoot, { mode: 0o700 });
await assert.rejects(check(longRoot), /too long for a private Unix socket/);
console.log(
	JSON.stringify({
		passed: true,
		arch: process.arch,
		wrongMode: true,
		wrongOwner: true,
		symlinkRoot: true,
		longSocket: true,
	}),
);
