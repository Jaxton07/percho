import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "packages/desktop");
const require = createRequire(import.meta.url);
const { dev } = JSON.parse(await readFile(join(desktop, "build/app-channels.json"), "utf8"));
const original = require("electron");
let executable = original;
const run = (command, args) => {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
};

if (process.platform === "darwin") {
	const source = resolve(dirname(original), "../..");
	const icon = join(desktop, "build/icon-dev.png");
	const executableStat = await stat(original);
	const digest = createHash("sha256")
		.update(await readFile(join(source, "Contents/Info.plist")))
		.update(await readFile(icon))
		.update(`${executableStat.size}:${executableStat.mtimeMs}:${dev.appId}:${dev.name}`)
		.digest("hex")
		.slice(0, 16);
	const cache = join(root, ".local/runtime/dev.noindex", digest);
	const bundle = join(cache, `${dev.name}.app`);
	executable = join(bundle, "Contents/MacOS/Electron");
	const ready = join(cache, "ready");
	let prepared = false;
	try {
		prepared = (await readFile(ready, "utf8")) === digest;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (!prepared) {
		console.log("Preparing Percho Dev with its own app identity and icon…");
		await mkdir(cache, { recursive: true });
		run("ditto", [source, bundle]);
		const iconset = join(cache, "dev.iconset");
		await mkdir(iconset, { recursive: true });
		for (const size of [16, 32, 128, 256, 512]) {
			for (const scale of [1, 2]) {
				const output = join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
				run("sips", ["-z", String(size * scale), String(size * scale), icon, "--out", output]);
			}
		}
		const icns = join(cache, "icon-dev.icns");
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
		await writeFile(ready, digest);
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
child.on("error", (error) => {
	console.error(error);
	process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
