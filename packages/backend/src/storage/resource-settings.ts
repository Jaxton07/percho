import { isAbsolute, join, relative, resolve } from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import { inside } from "./path-policy";

/** Inspect only SDK's global resource entries; never evaluate configuration commands. */
export function relocateResourceSettings(
	text: string,
	options: { source: string; sources: string[]; target: string; home: string; legacyRoots: string[] },
): { text: string; external: string[] } {
	const errors: ParseError[] = [],
		settings: unknown = parse(text, errors, { allowTrailingComma: true });
	if (errors.length || !settings || typeof settings !== "object" || Array.isArray(settings))
		throw new Error("Cannot safely read settings.json; fix its syntax before importing");
	const external: string[] = [];
	let output = text;
	for (const key of ["extensions", "skills", "prompts", "themes", "packages"]) {
		const values = (settings as Record<string, unknown>)[key];
		if (!Array.isArray(values)) continue;
		for (let index = 0; index < values.length; index++) {
			const item: unknown = values[index],
				object = !!item && typeof item === "object" && !Array.isArray(item);
			const value: unknown = object ? (item as Record<string, unknown>).source : item;
			if (typeof value !== "string") continue;
			const prefix = /^[!+-]/.test(value) ? value.charAt(0) : "",
				raw = value.slice(prefix.length);
			if (
				!/^[A-Za-z]:[/\\]/.test(raw) &&
				/^(?:[a-z][a-z\d+.-]*:|git@|(?:github|gitlab|bitbucket)\.)/i.test(raw)
			)
				continue;
			const tilde = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\");
			const absolute = tilde ? resolve(options.home, raw.slice(2)) : resolve(options.source, raw);
			const root = options.sources.find((source) => inside(source, absolute));
			let replacement = raw;
			if (root) {
				if (isAbsolute(raw) || tilde) replacement = join(options.target, relative(root, absolute));
			} else {
				if (options.legacyRoots.some((old) => inside(old, absolute)))
					throw new Error(`Resource points to other Pi data: ${raw}`);
				external.push(raw);
				if (!isAbsolute(raw) && !tilde) replacement = absolute;
			}
			if (replacement !== raw)
				output = applyEdits(
					output,
					modify(output, [key, index, ...(object ? ["source"] : [])], prefix + replacement, {}),
				);
		}
	}
	return { text: output, external };
}
