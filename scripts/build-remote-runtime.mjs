/** Build on the target Linux CPU. All dependency installs and intermediates stay under --out. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	chmod,
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import nodePolicy from "../packages/shared/src/runtime-node-policy.json" with { type: "json" };
import { runtimeBuildLock } from "./remote-runtime/production-lock.mjs";

const exec = promisify(execFile),
	repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out") throw new Error("Expected --out <isolated-output-directory>");
const out = resolve(args[1]),
	arch = process.arch;
if (
	process.platform !== "linux" ||
	!["x64", "arm64"].includes(arch) ||
	!process.report.getReport().header.glibcVersionRuntime
)
	throw new Error("Build on target glibc Linux x64/arm64");
if (!/^22\./.test(process.versions.node) || Number(process.versions.node.split(".")[1]) < 19)
	throw new Error("Build with Node 22.19+ (22.x)");
await mkdir(out, { recursive: true });
const work = await mkdtemp(join(out, ".runtime-build-")),
	stage = join(work, "package");
const desktop = JSON.parse(await readFile(join(repo, "packages/desktop/package.json"), "utf8")),
	releaseId = `v${desktop.version}`;
if (process.env.PERCHO_BUILD_RELEASE_TAG && process.env.PERCHO_BUILD_RELEASE_TAG !== releaseId)
	throw new Error("Release tag does not match desktop version");
if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(releaseId)) throw new Error("Invalid fixed release version");
const run = (command, argv, cwd = stage) =>
	exec(command, argv, {
		cwd,
		env: { ...process.env, npm_config_cache: join(out, ".npm-cache"), TMPDIR: work },
		timeout: 300000,
		maxBuffer: 4 * 1024 * 1024,
	});
try {
	await mkdir(stage);
	const selected = runtimeBuildLock(
		JSON.parse(await readFile(join(repo, "package-lock.json"), "utf8")),
		desktop.version,
	);
	await writeFile(join(stage, "package.json"), JSON.stringify(selected.manifest, null, 2));
	await writeFile(join(stage, "package-lock.json"), JSON.stringify(selected.lock, null, 2));
	await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
	const patches = join(work, "patches");
	await mkdir(patches);
	for (const name of [
		"@earendil-works+pi-agent-core+1.4.0.patch",
		"@earendil-works+pi-coding-agent+1.4.0.patch",
	]) {
		await copyFile(join(repo, "patches", name), join(patches, name));
	}
	await run(process.execPath, [
		join(stage, "node_modules/patch-package/index.js"),
		"--patch-dir",
		"../patches",
	]);
	const require = createRequire(join(stage, "package.json"));
	const { build } = await import(pathToFileURL(require.resolve("esbuild")).href);
	await build({
		absWorkingDir: repo,
		entryPoints: {
			cli: "packages/backend/src/runtime/cli.ts",
			client: "packages/backend/src/runtime/client.ts",
			server: "packages/backend/src/runtime/server.ts",
		},
		bundle: true,
		splitting: true,
		minifyWhitespace: true,
		legalComments: "eof",
		platform: "node",
		format: "esm",
		target: "node22",
		outdir: stage,
		outExtension: { ".js": ".mjs" },
		external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
		alias: {
			"@percho/shared": join(repo, "packages/shared/src/index.ts"),
			typebox: join(stage, "node_modules/percho-typebox-build"),
		},
		logLevel: "warning",
	});
	await copyFile(join(repo, "packages/backend/src/runtime/entry.mjs"), join(stage, "entry.mjs"));
	await build({
		absWorkingDir: repo,
		entryPoints: ["packages/shared/src/transcript/index.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		outfile: join(out, "recovery-projection.mjs"),
		logLevel: "warning",
	});
	const tools = JSON.parse(await readFile(join(repo, "scripts/remote-runtime/tools.json"), "utf8"));
	await mkdir(join(stage, "bin"));
	await mkdir(join(stage, "licenses"));
	for (const [name, tool] of Object.entries(tools)) {
		const url = tool.url.replace("{target}", arch === "arm64" ? "aarch64" : "x86_64");
		const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
		if (!response.ok) throw new Error(`Failed to obtain pinned ${name}: ${response.status}`);
		const data = Buffer.from(await response.arrayBuffer());
		if (data.length > 10 * 1024 * 1024 || createHash("sha256").update(data).digest("hex") !== tool[arch])
			throw new Error(`Pinned ${name} archive checksum mismatch`);
		const archive = join(work, `${name}.tar.gz`),
			unpacked = join(work, name);
		await writeFile(archive, data);
		await mkdir(unpacked);
		await run("tar", ["-xzf", archive, "--strip-components=1", "-C", unpacked]);
		await copyFile(join(unpacked, name), join(stage, "bin", name));
		await chmod(join(stage, "bin", name), 0o755);
		for (const file of await readdir(unpacked))
			if (/^(LICENSE|COPYING|UNLICENSE)/.test(file))
				await cp(join(unpacked, file), join(stage, "licenses", `${name}-${file}`));
		await run(join(stage, "bin", name), ["--version"]);
	}
	await run("npm", ["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
	delete selected.manifest.devDependencies;
	selected.manifest.perchoRuntime = {
		releaseId,
		platform: "linux",
		arch,
		minimumGlibc: "2.35",
		node: nodePolicy.node,
	};
	await writeFile(join(stage, "package.json"), `${JSON.stringify(selected.manifest, null, 2)}\n`);
	await rm(join(stage, "node_modules/.bin"), { recursive: true, force: true });
	await copyFile(join(repo, "LICENSE"), join(stage, "LICENSE"));
	// Failure here is a packaging error, never deferred to the target user's first conversation.
	const sdkRequire = createRequire(join(stage, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));
	await access(sdkRequire.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm"));
	await access(sdkRequire.resolve("quickjs-wasi/quickjs.wasm"));
	for (const file of [
		"node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
		"node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html",
	])
		await access(join(stage, file));
	const checked = JSON.parse(
		(await run(process.execPath, [join(stage, "entry.mjs"), "check", "--root", join(work, "offline-check")]))
			.stdout,
	);
	const asset = `percho-runtime-linux-${arch}.tar.gz`,
		archive = join(work, asset);
	await run("tar", [
		"--format=ustar",
		"--sort=name",
		"--mtime=@0",
		"--owner=0",
		"--group=0",
		"--numeric-owner",
		"--dereference",
		"--hard-dereference",
		"-czf",
		archive,
		"-C",
		stage,
		".",
	]);
	const bytes = await readFile(archive),
		sha256 = createHash("sha256").update(bytes).digest("hex");
	const manifest = {
		version: 1,
		releaseId,
		runtimeVersion: desktop.version,
		protocol: checked.protocol,
		sdkVersion: checked.sdkVersion,
		minimumGlibc: "2.35",
		node: nodePolicy.node,
		arch,
		asset,
		bytes: bytes.length,
		sha256,
		url: `https://github.com/Jaxton07/percho/releases/download/${releaseId}/${asset}`,
	};
	await rename(archive, join(out, asset));
	const metadataFile = join(work, "runtime.json");
	await writeFile(metadataFile, `${JSON.stringify(manifest, null, 2)}\n`);
	await rename(metadataFile, join(out, `runtime-linux-${arch}.json`));
	console.log(JSON.stringify({ built: true, arch, asset, bytes: bytes.length, sha256 }));
} finally {
	await rm(work, { recursive: true, force: true });
}
