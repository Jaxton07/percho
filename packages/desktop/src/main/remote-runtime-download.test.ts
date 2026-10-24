import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	downloadRuntimeArtifact,
	parseRuntimeManifest,
	type RuntimeArtifact,
} from "./remote-runtime-download";

const roots: string[] = [];
async function directory() {
	const parent = resolve("../../.local/tmp/ssh-remote-runtime/download-tests");
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(join(parent, "case-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const body = Buffer.from("verified artifact");
const artifact: RuntimeArtifact = {
	asset: "percho-runtime-linux-arm64.tar.gz",
	url: "https://github.com/Jaxton07/percho/releases/download/v1.0.0/percho-runtime-linux-arm64.tar.gz",
	bytes: body.length,
	sha256: createHash("sha256").update(body).digest("hex"),
};
it("downloads exactly the trusted bytes, atomically caches them, and revalidates corrupt cache", async () => {
	const root = await directory(),
		request = vi.fn().mockImplementation(async () => new Response(body));
	const signal = new AbortController().signal;
	const first = await downloadRuntimeArtifact(artifact, root, signal, request);
	expect(await downloadRuntimeArtifact(artifact, root, signal, request)).toBe(first);
	expect(request).toHaveBeenCalledTimes(1);
	await writeFile(first, "corrupt");
	await downloadRuntimeArtifact(artifact, root, signal, request);
	expect(request).toHaveBeenCalledTimes(2);
	expect(await readdir(root)).toEqual([`${artifact.sha256}.tar.gz`]);
});
it("rejects failed, short, excessive, incorrect-digest and cancelled downloads without a partial artifact", async () => {
	for (const response of [
		new Response("failure", { status: 404 }),
		new Response(body.subarray(1)),
		new Response(Buffer.concat([body, body])),
		new Response(Buffer.alloc(body.length)),
		new Response(body, { headers: { "content-length": "1" } }),
	]) {
		const root = await directory();
		await expect(
			downloadRuntimeArtifact(
				artifact,
				root,
				new AbortController().signal,
				vi.fn().mockResolvedValue(response),
			),
		).rejects.toThrow();
		expect(await readdir(root)).toEqual([]);
	}
	const root = await directory(),
		controller = new AbortController();
	controller.abort();
	await expect(
		downloadRuntimeArtifact(artifact, root, controller.signal, vi.fn().mockResolvedValue(new Response(body))),
	).rejects.toThrow();
	expect(await readdir(root)).toEqual([]);
});
it("only accepts fixed official source identities and the supported manifest contract", () => {
	const base = {
		version: 1,
		releaseId: "v1.0.0",
		runtimeVersion: "1.0.0",
		protocol: 3,
		minimumGlibc: "2.35",
		node: ">=22.19.0 <23",
		artifacts: {
			arm64: artifact,
			x64: {
				...artifact,
				asset: artifact.asset.replace("arm64", "x64"),
				url: artifact.url.replaceAll("arm64", "x64"),
			},
		},
	};
	expect(parseRuntimeManifest(base)).toEqual(base);
	expect(() =>
		parseRuntimeManifest({
			...base,
			artifacts: { ...base.artifacts, arm64: { ...artifact, url: "https://mirror.invalid/archive" } },
		}),
	).toThrow();
	expect(() => parseRuntimeManifest({ ...base, releaseId: "latest" })).toThrow();
	expect(() => parseRuntimeManifest({ ...base, protocol: 999 })).toThrow();
});
