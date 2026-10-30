import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { retireMacApplication } from "./macos-app-cleanup.mjs";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "packages/desktop");
const require = createRequire(import.meta.url);
const { dev } = JSON.parse(await readFile(join(desktop, "build/app-channels.json"), "utf8"));
const original = require("electron");
let executable = original;
let devBundle;
let devDirectory;
async function cleanDevApplication() {
	if (!devDirectory) return;
	try {
		await retireMacApplication(devBundle, { remove: true });
	} finally {
		await rm(devDirectory, { recursive: true, force: true });
	}
}
const run = (command, args) => {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
};

if (process.platform === "darwin") {
	const source = resolve(dirname(original), "../..");
	const icon = join(desktop, "build/icon-dev.png");
	const directory = join(root, ".local/runtime/dev.noindex");
	await mkdir(directory, { recursive: true });
	// Each invocation owns its shell, so stopping one dev process cannot delete another's app.
	devDirectory = await mkdtemp(join(directory, "session-"));
	const bundle = join(devDirectory, `${dev.name}.app`);
	devBundle = bundle;
	executable = join(bundle, "Contents/MacOS/Electron");
	try {
		console.log("Preparing Percho Dev with its own app identity and icon…");
		run("ditto", [source, bundle]);
		const iconset = join(devDirectory, "dev.iconset");
		await mkdir(iconset, { recursive: true });
		for (const size of [16, 32, 128, 256, 512]) {
			for (const scale of [1, 2]) {
				const output = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
				run("sips", ["-z", String(size * scale), String(size * scale), icon, "--out", output]);
			}
		}
		const icns = join(devDirectory, "icon-dev.icns");
		run("iconutil", ["-c", "icns", iconset, "-o", icns]);
		await copyFile(icns, join(bundle, "Contents/Resources/icon-dev.icns"));
		const plist = join(bundle, "Contents/Info.plist");
		for (const [key, value] of Object.entries({
			CFBundleIdentifier: dev.appId,
			CFBundleDisplayName: dev.name,
			CFBundleName: dev.name,
			CFBundleIconFile: "icon-dev.icns",
		}))
			run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
		run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
	} catch (error) {
		await cleanDevApplication();
		throw error;
	}
}

const cli = join(dirname(require.resolve("electron-vite/package.json")), "bin/electron-vite.js");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const child = spawn(process.execPath, [cli, "dev", "--", ...args], {
	cwd: desktop,
	stdio: "inherit",
	env: { ...process.env, ELECTRON_EXEC_PATH: executable },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
let finishing = false;
async function finish(code) {
	if (finishing) return;
	finishing = true;
	try {
		await cleanDevApplication();
	} catch (error) {
		console.warn(`Could not clean up development app registration: ${error.message}`);
	}
	process.exit(code);
}
child.on("error", (error) => {
	console.error(error);
	void finish(1);
});
child.on("exit", (code, signal) => void finish(code ?? (signal ? 1 : 0)));
