import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { REMOTE_PROTOCOL_VERSION } from "@percho/shared";

const MAX_ARCHIVE = 256 * 1024 * 1024;
export interface RuntimeArtifact {
	asset: string;
	url: string;
	sha256: string;
	bytes: number;
}
export interface RuntimeManifest {
	version: 1;
	releaseId: string;
	runtimeVersion: string;
	protocol: number;
	minimumGlibc: "2.35";
	node: ">=22.19.0 <23";
	artifacts: Record<"x64" | "arm64", RuntimeArtifact>;
}
export function parseRuntimeManifest(input: unknown): RuntimeManifest {
	const value = input as RuntimeManifest;
	if (
		value?.version !== 1 ||
		!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.runtimeVersion) ||
		value.releaseId !== `v${value.runtimeVersion}` ||
		value.protocol !== REMOTE_PROTOCOL_VERSION ||
		value.minimumGlibc !== "2.35" ||
		value.node !== ">=22.19.0 <23"
	)
		throw new Error("Invalid bundled runtime manifest");
	for (const arch of ["x64", "arm64"] as const) {
		const item = value.artifacts?.[arch];
		const asset = `percho-runtime-linux-${arch}.tar.gz`;
		if (
			!item ||
			item.asset !== asset ||
			item.url !== `https://github.com/Jaxton07/percho/releases/download/${value.releaseId}/${asset}` ||
			!/^[a-f0-9]{64}$/.test(item.sha256) ||
			!Number.isSafeInteger(item.bytes) ||
			item.bytes < 1 ||
			item.bytes > MAX_ARCHIVE
		)
			throw new Error("Invalid official runtime artifact");
	}
	return value;
}
async function matches(path: string, item: RuntimeArtifact): Promise<boolean> {
	try {
		if ((await stat(path)).size !== item.bytes) return false;
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		return hash.digest("hex") === item.sha256;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
/** The fetch dependency allows isolated transport fault tests, never a user-configured mirror. */
export async function downloadRuntimeArtifact(
	item: RuntimeArtifact,
	directory: string,
	signal: AbortSignal,
	request: typeof fetch = fetch,
): Promise<string> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const destination = join(directory, `${item.sha256}.tar.gz`);
	if (await matches(destination, item)) {
		signal.throwIfAborted();
		return destination;
	}
	const temporary = join(directory, `${randomUUID()}.partial`);
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const timer = setTimeout(() => controller.abort(new Error("Official runtime download timed out")), 120_000);
	try {
		// Fetch follows GitHub's signed asset redirect. Every response is still checked against the bundled digest.
		const response = await request(item.url, { signal: controller.signal, redirect: "follow" });
		if (!response.ok || !response.body)
			throw new Error(`Official runtime download failed (${response.status})`);
		if (response.url && !response.url.startsWith("https://"))
			throw new Error("Runtime download requires HTTPS");
		const length = response.headers.get("content-length");
		if (length !== null && Number(length) !== item.bytes) throw new Error("Runtime download size mismatch");
		const file = await open(temporary, "wx", 0o600),
			hash = createHash("sha256");
		let bytes = 0;
		try {
			for await (const chunk of response.body) {
				controller.signal.throwIfAborted();
				bytes += chunk.length;
				if (bytes > item.bytes) throw new Error("Runtime download exceeds expected size");
				hash.update(chunk);
				await file.writeFile(chunk);
			}
		} finally {
			await file.close();
		}
		if (bytes !== item.bytes || hash.digest("hex") !== item.sha256)
			throw new Error("Runtime download SHA256 or size mismatch");
		controller.signal.throwIfAborted();
		await rename(temporary, destination);
		return destination;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		await rm(temporary, { force: true });
	}
}
export async function readRuntimeManifest(path: string): Promise<RuntimeManifest> {
	try {
		return parseRuntimeManifest(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		throw new Error(
			"A verified official runtime manifest is required to install. Use a packaged desktop release or prepare its release resources.",
			{ cause: error },
		);
	}
}
