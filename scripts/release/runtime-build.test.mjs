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

test("runtime build lock retains production MCP and channel locks with build-only shared semver", () => {
	const selected = runtimeBuildLock(lock, "0.0.0-test");
	assert.equal(selected.manifest.devDependencies["percho-semver-build"], `npm:semver@${semver.version}`);
	assert.equal(selected.lock.packages["node_modules/percho-semver-build"].version, semver.version);
	assert.equal(selected.lock.packages["node_modules/percho-semver-build"].dev, true);
	assert.equal(selected.manifest.dependencies["percho-semver-build"], undefined);
	assert.equal(selected.lock.packages["node_modules/@earendil-works/pi-mcp"].version, "1.5.1");
	assert.notEqual(selected.lock.packages["node_modules/@earendil-works/pi-mcp"].dev, true);
	assert.equal(selected.manifest.dependencies["proper-lockfile"], "4.1.2");
	assert.equal(selected.lock.packages["node_modules/proper-lockfile"].version, "4.1.2");
	assert.notEqual(selected.lock.packages["node_modules/proper-lockfile"].dev, true);
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

test("runtime bundle resolves isolated helpers and loads channel locks without checkout dependencies", async (t) => {
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
	const selected = runtimeBuildLock(lock, "0.0.0-test");
	for (const key of Object.keys(selected.lock.packages)) {
		if (/^node_modules\/(proper-lockfile|graceful-fs|retry|signal-exit)(\/|$)/.test(key))
			await cp(join(root, key), join(stage, key), { recursive: true });
	}
	await cp(dirname(semverPath), aliases.semver, { recursive: true });
	const typeboxKey = lock.packages["packages/backend/node_modules/typebox"]
		? "packages/backend/node_modules/typebox"
		: "node_modules/typebox";
	await cp(join(root, typeboxKey), aliases.typebox, { recursive: true });
	await cp(
		join(root, "node_modules/@earendil-works/pi-mcp"),
		join(stage, "node_modules/@earendil-works/pi-mcp"),
		{ recursive: true },
	);
	await writeFile(
		join(source, "entry.ts"),
		`
		import { isNewerVersion } from "./packages/shared/src/packages";
		import { Type } from "typebox";
		import lockfile from "proper-lockfile";
		export const canLock = typeof lockfile.lock === "function";
		export const acquire = lockfile.lock;
		import { isMcpServerOverride, mcpNamespace } from "@earendil-works/pi-mcp";
		export const namespace = mcpNamespace("my-server");
		export const override = isMcpServerOverride({ enabled: false });
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
		external: Object.keys(selected.manifest.dependencies),
		logLevel: "silent",
		plugins: [
			{
				name: "no-checkout-dependencies",
				setup(builder) {
					// CI masks checkout node_modules. Do not let local ancestor installs hide a missing alias.
					builder.onResolve(
						{ filter: /^(semver|typebox|proper-lockfile|@earendil-works\/pi-mcp)(\/|$)/ },
						async (args) => {
							if (args.pluginData?.checked) return;
							const resolved = await builder.resolve(args.path, {
								resolveDir: args.resolveDir,
								kind: args.kind,
								pluginData: { checked: true },
							});
							if (
								!resolved.external &&
								!resolved.errors.length &&
								relative(stage, resolved.path).startsWith("..")
							) {
								return { errors: [{ text: `Outside isolated install: ${args.path}` }] };
							}
							return resolved;
						},
					);
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
	await assert.rejects(
		build({
			...options,
			alias: aliases,
			external: options.external.filter((name) => name !== "proper-lockfile"),
		}),
		/Could not resolve|Outside isolated install/,
	);
	await build({ ...options, alias: aliases });
	// CommonJS lockfile stays a runtime dependency; build-only aliases must still be removable.
	for (const name of ["@earendil-works/pi-mcp", "percho-semver-build", "percho-typebox-build"])
		await rm(join(stage, "node_modules", name), { recursive: true, force: true });
	const runtimeRequire = createRequire(outfile);
	assert.equal(relative(stage, runtimeRequire.resolve("proper-lockfile")).startsWith(".."), false);
	const result = await import(pathToFileURL(outfile).href);
	assert.equal(result.canLock, true);
	const release = await result.acquire(join(stage, "channel.json"), { realpath: false });
	await release();
	assert.equal(result.newer, true);
	assert.equal(result.schema.type, "object");
	assert.equal(result.namespace, "mcp__my_server");
	assert.equal(result.override, true);
});
