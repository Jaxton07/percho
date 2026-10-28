import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import nodePolicy from "../../packages/shared/src/runtime-node-policy.json" with { type: "json" };
import { sha256 } from "./run.mjs";

export async function prepareRuntimeManifest(input, output, release, requirePublished = false) {
	const manifests = [];
	for (const arch of ["x64", "arm64"]) {
		const item = JSON.parse(await readFile(resolve(input, `runtime-linux-${arch}.json`), "utf8"));
		const asset = `percho-runtime-linux-${arch}.tar.gz`;
		if (
			item.version !== 1 ||
			item.arch !== arch ||
			item.asset !== asset ||
			item.releaseId !== release.tag ||
			item.runtimeVersion !== release.version ||
			item.sourceCommit !== release.sourceCommit ||
			item.minimumGlibc !== "2.35" ||
			item.node !== nodePolicy.node ||
			!Number.isInteger(item.protocol) ||
			typeof item.sdkVersion !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.sha256) ||
			!Number.isSafeInteger(item.bytes) ||
			item.bytes < 1 ||
			item.bytes > 256 * 1024 * 1024 ||
			item.url !== `https://github.com/Jaxton07/percho/releases/download/${release.tag}/${asset}`
		)
			throw new Error(`Runtime metadata does not match release version/source (${arch})`);
		const path = resolve(input, asset);
		const { size } = await stat(path);
		if (size !== item.bytes || (await sha256(path)) !== item.sha256)
			throw new Error(`Runtime artifact integrity failed (${arch})`);
		if (requirePublished) {
			const response = await fetch(item.url, { method: "HEAD", signal: AbortSignal.timeout(30000) });
			if (!response.ok) throw new Error(`Runtime asset is not published (${arch})`);
		}
		manifests.push(item);
	}
	const [first, second] = manifests;
	for (const key of ["protocol", "sdkVersion", "minimumGlibc", "node"])
		if (first[key] !== second[key]) throw new Error(`Runtime architecture metadata differs: ${key}`);
	const { arch: _arch, asset: _asset, url: _url, sha256: _sha, bytes: _bytes, ...common } = first;
	const artifacts = Object.fromEntries(
		manifests.map(({ arch, asset, url, sha256, bytes }) => [arch, { asset, url, sha256, bytes }]),
	);
	const manifest = { ...common, artifacts };
	if (output) {
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
	}
	return manifest;
}
