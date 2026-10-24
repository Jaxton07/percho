import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
if (
	![4, 5].includes(args.length) ||
	args[0] !== "--input" ||
	args[2] !== "--output" ||
	(args[4] && args[4] !== "--require-published")
)
	throw new Error("Expected --input <artifact-directory> --output <desktop-manifest> [--require-published]");
const input = resolve(args[1]),
	output = resolve(args[3]),
	manifests = [];
for (const arch of ["x64", "arm64"]) {
	const item = JSON.parse(await readFile(resolve(input, `runtime-linux-${arch}.json`), "utf8"));
	const asset = `percho-runtime-linux-${arch}.tar.gz`;
	if (
		item.version !== 1 ||
		item.arch !== arch ||
		item.asset !== asset ||
		!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(item.releaseId) ||
		item.releaseId !== `v${item.runtimeVersion}` ||
		item.minimumGlibc !== "2.35" ||
		item.node !== ">=22.19.0 <23" ||
		!Number.isInteger(item.protocol) ||
		typeof item.sdkVersion !== "string" ||
		!/^[a-f0-9]{64}$/.test(item.sha256) ||
		item.url !== `https://github.com/Jaxton07/percho/releases/download/${item.releaseId}/${asset}`
	)
		throw new Error(`Invalid trusted runtime artifact metadata (${arch})`);
	const bytes = await readFile(resolve(input, asset));
	if (
		bytes.length !== item.bytes ||
		bytes.length > 256 * 1024 * 1024 ||
		createHash("sha256").update(bytes).digest("hex") !== item.sha256
	)
		throw new Error(`Runtime artifact integrity failed (${arch})`);
	if (args[4]) {
		const response = await fetch(item.url, { method: "HEAD", signal: AbortSignal.timeout(30000) });
		if (!response.ok)
			throw new Error(`Publish the runtime artifact before distributing its desktop reference (${arch})`);
	}
	manifests.push(item);
}
const [first, second] = manifests;
for (const key of ["releaseId", "runtimeVersion", "protocol", "sdkVersion", "minimumGlibc", "node"])
	if (first[key] !== second[key]) throw new Error(`Runtime architecture metadata differs: ${key}`);
const { arch: _arch, asset: _asset, url: _url, sha256: _sha, bytes: _bytes, ...common } = first;
const artifacts = Object.fromEntries(
	manifests.map(({ arch, asset, url, sha256, bytes }) => [arch, { asset, url, sha256, bytes }]),
);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ ...common, artifacts }, null, 2)}\n`);
console.log(
	JSON.stringify({ prepared: true, releaseId: first.releaseId, architectures: Object.keys(artifacts) }),
);
