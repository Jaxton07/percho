import { join, posix } from "node:path";
import nodePolicy from "../../packages/shared/src/runtime-node-policy.json" with { type: "json" };

export const RUNTIME_NPM_REGISTRY = "https://registry.npmjs.org";

/** Select exact installed lock entries, without introducing another dependency/version solver. */
export function runtimeBuildLock(lock, version) {
	const dependencies = { "@earendil-works/pi-coding-agent": "1.5.1", "@earendil-works/pi-ai": "1.5.1" };
	const devDependencies = { esbuild: "0.25.12", "patch-package": "8.0.1" };
	const packages = {};
	const production = new Set();
	const locate = (parent, name, optional = false) => {
		let current = parent;
		for (;;) {
			const candidate = posix.join(current, "node_modules", name);
			if (lock.packages[candidate] && !lock.packages[candidate].link) return candidate;
			if (!current || current === ".") break;
			current = posix.dirname(current);
		}
		if (optional) return null;
		throw new Error(`Runtime dependency missing from committed lock: ${parent} -> ${name}`);
	};
	const visit = (key, runtime) => {
		if (runtime && production.has(key)) return;
		if (!runtime && packages[key]) return;
		const source = lock.packages[key];
		packages[key] = { ...source };
		delete packages[key].devOptional;
		if (runtime) {
			production.add(key);
			delete packages[key].dev;
		} else packages[key].dev = true;
		for (const name of new Set([
			...Object.keys(source.dependencies ?? {}),
			...Object.keys(source.optionalDependencies ?? {}),
			...Object.keys(source.peerDependencies ?? {}),
		])) {
			const optional =
				name in (source.optionalDependencies ?? {}) || source.peerDependenciesMeta?.[name]?.optional;
			const child = locate(key, name, optional);
			if (child) visit(child, runtime);
		}
	};
	for (const name of Object.keys(dependencies)) visit(locate("", name), true);
	for (const name of Object.keys(devDependencies)) visit(locate("", name), false);
	for (const [name, expected] of Object.entries({ ...dependencies, ...devDependencies })) {
		if (packages[`node_modules/${name}`]?.version !== expected)
			throw new Error(`Runtime lock mismatch for ${name}`);
	}
	const typebox =
		lock.packages["packages/backend/node_modules/typebox"] ?? lock.packages["node_modules/typebox"];
	if (typebox?.version !== "1.3.7" || Object.keys(typebox.dependencies ?? {}).length)
		throw new Error("Backend TypeBox build dependency changed; update the explicit runtime build alias");
	devDependencies["percho-typebox-build"] = "npm:typebox@1.3.7";
	packages["node_modules/percho-typebox-build"] = { ...typebox, name: "typebox", dev: true };
	const semver = lock.packages[locate("packages/shared", "semver")];
	if (Object.keys(semver.dependencies ?? {}).length || Object.keys(semver.optionalDependencies ?? {}).length)
		throw new Error("Shared semver build dependency changed; update the explicit runtime build alias");
	devDependencies["percho-semver-build"] = `npm:semver@${semver.version}`;
	packages["node_modules/percho-semver-build"] = { ...semver, name: "semver", dev: true };
	// The isolated build has no warm checkout cache. Avoid a regional mirror/CDN dependency,
	// while preserving the committed versions and integrity checks (and never mutating that lock).
	const mirror = "https://registry.npmmirror.com/";
	for (const entry of Object.values(packages)) {
		if (entry.resolved?.startsWith(mirror))
			entry.resolved = `${RUNTIME_NPM_REGISTRY}/${entry.resolved.slice(mirror.length)}`;
	}
	const manifest = {
		name: "percho-remote-runtime",
		version,
		private: true,
		type: "module",
		license: "MIT",
		engines: { node: nodePolicy.node },
		dependencies,
		devDependencies,
	};
	return {
		manifest,
		lock: {
			name: manifest.name,
			version,
			lockfileVersion: 3,
			requires: true,
			packages: { "": manifest, ...packages },
		},
	};
}

/** Workspace imports must resolve against the isolated install, never checkout node_modules. */
export function runtimeBuildAliases(repo, stage) {
	return {
		"@percho/shared": join(repo, "packages/shared/src/index.ts"),
		typebox: join(stage, "node_modules/percho-typebox-build"),
		semver: join(stage, "node_modules/percho-semver-build"),
	};
}
