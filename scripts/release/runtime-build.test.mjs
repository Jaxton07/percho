import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { runtimeBuildAliases, runtimeBuildLock } from "../remote-runtime/production-lock.mjs";
import { root } from "./plan.mjs";

const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const sharedRequire = createRequire(join(root, "packages/shared/package.json"));
const semverPath = sharedRequire.resolve("semver/package.json");
const semver = JSON.parse(await readFile(semverPath, "utf8"));

test("runtime build lock pins shared semver as an isolated build dependency", () => {
	const selected = runtimeBuildLock(lock, "0.0.0-test");
	assert.equal(selected.manifest.devDependencies["percho-semver-build"], `npm:semver@${semver.version}`);
	assert.equal(selected.lock.packages["node_modules/percho-semver-build"].version, semver.version);
	assert.equal(selected.lock.packages["node_modules/percho-semver-build"].dev, true);
	assert.equal(selected.manifest.dependencies["percho-semver-build"], undefined);
});

test("runtime install uses the official tarball source without changing versions, integrity or the checkout lock", () => {
	const source = structuredClone(lock);
	const key = "node_modules/@earendil-works/pi-ai";
	source.packages[key].resolved = "https://registry.npmmirror.com/@earendil-works/pi-ai/-/pi-ai-1.4.0.tgz";
	const original = structuredClone(source);
	const selected = runtimeBuildLock(source, "0.0.0-test");
	assert.equal(
		selected.lock.packages[key].resolved,
		"https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.4.0.tgz",
	);
	for (const [path, entry] of Object.entries(selected.lock.packages)) {
		if (!path) continue;
		assert.equal(entry.resolved?.startsWith("https://registry.npmmirror.com/"), false);
		const originalEntry =
			path === "node_modules/percho-typebox-build"
				? (source.packages["packages/backend/node_modules/typebox"] ??
					source.packages["node_modules/typebox"])
				: path === "node_modules/percho-semver-build"
					? source.packages[relative(root, dirname(semverPath)).replaceAll("\\", "/")]
					: source.packages[path];
		assert.equal(entry.version, originalEntry.version);
		assert.equal(entry.integrity, originalEntry.integrity);
	}
	assert.deepEqual(source, original);
});

test("runtime install preserves official and unrelated tarball hosts", () => {
	const source = structuredClone(lock);
	const key = "node_modules/@earendil-works/pi-ai";
	for (const resolved of [
		"https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.4.0.tgz",
		"https://registry.npmmirror.com.example.test/package.tgz",
	]) {
		source.packages[key].resolved = resolved;
		assert.equal(runtimeBuildLock(source, "0.0.0-test").lock.packages[key].resolved, resolved);
	}
});

test("runtime bundle resolves semver subpaths without checkout dependencies", async (t) => {
	const parent = join(root, ".local/tmp/runtime-build-tests");
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(join(parent, "case-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = join(directory, "source");
	const stage = join(directory, "package");
	const shared = join(source, "packages/shared/src");
	await mkdir(shared, { recursive: true });
	await cp(join(root, "packages/shared/src/packages.ts"), join(shared, "packages.ts"));
	const aliases = runtimeBuildAliases(source, stage);
	await cp(dirname(semverPath), aliases.semver, { recursive: true });
	const typeboxKey = lock.packages["packages/backend/node_modules/typebox"]
		? "packages/backend/node_modules/typebox"
		: "node_modules/typebox";
	await cp(join(root, typeboxKey), aliases.typebox, { recursive: true });
	await writeFile(
		join(source, "entry.ts"),
		`
		import { isNewerVersion } from "./packages/shared/src/packages";
		import { Type } from "typebox";
		export const newer = isNewerVersion("1.2.0", "1.2.0-beta.1");
		export const schema = Type.Object({ version: Type.String() });
	`,
	);
	const outfile = join(stage, "check.mjs");
	const options = {
		absWorkingDir: source,
		entryPoints: ["entry.ts"],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		outfile,
		logLevel: "silent",
		plugins: [
			{
				name: "no-checkout-dependencies",
				setup(builder) {
					// CI masks checkout node_modules. Do not let local ancestor installs hide a missing alias.
					builder.onResolve({ filter: /^(semver|typebox)(\/|$)/ }, async (args) => {
						if (args.pluginData?.checked) return;
						const resolved = await builder.resolve(args.path, {
							resolveDir: args.resolveDir,
							kind: args.kind,
							pluginData: { checked: true },
						});
						if (!resolved.errors.length && relative(stage, resolved.path).startsWith("..")) {
							return { errors: [{ text: `Outside isolated install: ${args.path}` }] };
						}
						return resolved;
					});
				},
			},
		],
	};
	const withoutSemver = { ...aliases };
	delete withoutSemver.semver;
	await assert.rejects(
		build({ ...options, alias: withoutSemver }),
		/Could not resolve|Outside isolated install/,
	);
	await build({ ...options, alias: aliases });
	// The aliases are build-only; the emitted bundle must keep working after those installs are removed.
	await rm(join(stage, "node_modules"), { recursive: true, force: true });
	const result = await import(pathToFileURL(outfile).href);
	assert.equal(result.newer, true);
	assert.equal(result.schema.type, "object");
});
