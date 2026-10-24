import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { REMOTE_PROTOCOL_VERSION } from "@percho/shared";

interface RuntimeRelease {
	version: string;
	releaseId: string;
	arch: "x64" | "arm64";
	minimumGlibc: string;
}
const packageRoot = dirname(fileURLToPath(import.meta.url));
export async function readRuntimeRelease(): Promise<RuntimeRelease | null> {
	let text: string;
	try {
		text = await readFile(join(packageRoot, "package.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const metadata = JSON.parse(text),
		release = metadata.perchoRuntime;
	if (
		metadata.name !== "percho-remote-runtime" ||
		typeof metadata.version !== "string" ||
		!release ||
		release.platform !== "linux" ||
		!["x64", "arm64"].includes(release.arch) ||
		release.releaseId !== `v${metadata.version}` ||
		release.minimumGlibc !== "2.35"
	)
		throw new Error("Invalid runtime release metadata");
	return {
		version: metadata.version,
		releaseId: release.releaseId,
		arch: release.arch,
		minimumGlibc: release.minimumGlibc,
	};
}
export function assertRuntimeReleasePlatform(release: RuntimeRelease, glibc: string): void {
	if (process.arch !== release.arch) throw new Error("Runtime package CPU architecture mismatch");
	const [major = 0, minor = 0] = glibc.split(".").map(Number);
	if (major < 2 || (major === 2 && minor < 35)) throw new Error("Runtime requires glibc 2.35 or newer");
	const [nodeMajor, nodeMinor = 0] = process.versions.node.split(".").map(Number);
	if (nodeMajor !== 22 || nodeMinor < 19) throw new Error("Runtime requires Node 22.19+ (22.x)");
}
/** Offline package check: no backend, owner lock, credentials or service is created. */
export async function checkRuntimeRelease(release: RuntimeRelease | null): Promise<void> {
	if (!release) throw new Error("An installed release package is required for an offline check");
	const sdk = await import("@earendil-works/pi-coding-agent");
	if (
		typeof sdk.AgentSession.prototype.retryLastFailedTurn !== "function" ||
		typeof sdk.createMcpExtension !== "function" ||
		typeof sdk.createCodemodeExtension !== "function"
	)
		throw new Error("Required Percho SDK patch or built-in extensions are missing");
	const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
	await access(sdkRequire.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm"));
	await access(sdkRequire.resolve("quickjs-wasi/quickjs.wasm"));
	for (const relative of [
		"node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
		"node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/codemode-worker.js",
		"node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/image-resize-worker.js",
		"node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html",
	])
		await access(join(packageRoot, relative));
	for (const name of ["fd", "rg"])
		await promisify(execFile)(join(packageRoot, "bin", name), ["--version"], {
			timeout: 5000,
			maxBuffer: 16384,
		});
	process.stdout.write(
		`${JSON.stringify({ ok: true, ...release, protocol: REMOTE_PROTOCOL_VERSION, sdkVersion: sdk.VERSION })}\n`,
	);
}
