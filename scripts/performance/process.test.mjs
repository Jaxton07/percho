import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runProcess } from "./process.mjs";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function temporary(fn) {
	const base = join(repo, ".local/tmp/performance-process-tests");
	await mkdir(base, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(base, "case-"));
	try {
		await fn(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("a failed command preserves its log and the real command error", async () =>
	temporary(async (directory) => {
		const logFile = join(directory, "command.log");
		await assert.rejects(
			runProcess({
				args: ["-e", "console.error('fixture failure');process.exitCode=7"],
				cwd: repo,
				env: { PATH: process.env.PATH },
				logFile,
			}),
			/Command failed \(7\)/,
		);
		assert.match(await readFile(logFile, "utf8"), /fixture failure/);
	}));

test(
	"normal leader exit still cleans its running descendant group",
	{ skip: process.platform === "win32" },
	async () =>
		temporary(async (directory) => {
			const file = join(directory, "child.pid");
			const code = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(file)},String(c.pid));c.unref()`;
			await runProcess({
				args: ["-e", code],
				cwd: repo,
				env: { PATH: process.env.PATH },
				logFile: join(directory, "command.log"),
			});
			const pid = Number(await readFile(file, "utf8"));
			const state = await exec("/bin/ps", ["-p", String(pid), "-o", "stat="])
				.then((result) => result.stdout.trim())
				.catch(() => "");
			assert(!state || state.startsWith("Z"), "Descendant must not remain running");
		}),
);

test(
	"an abort force-stops a command that ignores SIGTERM",
	{ skip: process.platform === "win32" },
	async () =>
		temporary(async (directory) => {
			const controller = new AbortController();
			const logFile = join(directory, "command.log");
			const done = runProcess({
				args: ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
				cwd: repo,
				env: { PATH: process.env.PATH },
				logFile,
				signal: controller.signal,
			}).then(
				(value) => ({ value }),
				(error) => ({ error }),
			);
			const deadline = Date.now() + 10000;
			while (!(await readFile(logFile, "utf8").catch(() => "")).includes("ready")) {
				assert(Date.now() < deadline, "Fixture did not become ready");
				await pause(20);
			}
			controller.abort(new Error("fixture interrupted"));
			const result = await done;
			assert.match(result.error?.message ?? "", /fixture interrupted/);
		}),
);
