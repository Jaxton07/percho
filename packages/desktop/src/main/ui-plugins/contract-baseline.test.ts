import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_UI_REGIONS, KNOWN_UI_SLOTS } from "@percho/shared";
import { transform } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildPlugin } from "./build";

const source = async (relative: string) =>
	ts.createSourceFile(
		relative,
		await readFile(new URL(relative, import.meta.url), "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
function find<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
	const result: T[] = [];
	const visit = (node: ts.Node) => {
		if (predicate(node)) result.push(node);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return result;
}
function required<T>(value: T | undefined): T {
	if (value === undefined) throw Error("Missing contract value");
	return value;
}
function name(node: ts.Node | undefined): string {
	node = required(node);
	return ts.isStringLiteral(node) || ts.isIdentifier(node) ? node.text : node.getText();
}
function objectVariable(root: ts.SourceFile, variable: string): ts.ObjectLiteralExpression {
	const declaration = find(root, ts.isVariableDeclaration).find((node) => node.name.getText() === variable);
	if (!declaration?.initializer || !ts.isObjectLiteralExpression(declaration.initializer))
		throw Error(variable);
	return declaration.initializer;
}
function exportedValues(root: ts.Node): string[] {
	return find(root, ts.isVariableStatement)
		.filter((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
		.flatMap((node) =>
			node.declarationList.declarations.flatMap((decl) =>
				ts.isObjectBindingPattern(decl.name)
					? decl.name.elements.map((element) => name(element.name))
					: [name(decl.name)],
			),
		)
		.sort();
}
function interfaceFields(root: ts.Node, id: string): string[] {
	const declaration = find(root, ts.isInterfaceDeclaration).find((node) => node.name.text === id);
	if (!declaration) throw Error(id);
	return declaration.members.flatMap((member) => (member.name ? [name(member.name)] : [])).sort();
}
const difference = (a: string[], b: string[]) => a.filter((value) => !b.includes(value)).sort();

// These record the existing public surface and known declaration gaps, not a claim of no drift.
// Ticket 07 must flip the explicit gap expectations to equality, without removing runtime exports.
describe("V07 plugin public surface characteristics", () => {
	it("all four real shims build and resolve every runtime export against the host groups", async () => {
		const buildSource = await source("./build.ts");
		const shims = objectVariable(buildSource, "SHIMS");
		const runtimeNames: Record<string, string[]> = {};
		for (const prop of shims.properties) {
			if (!ts.isPropertyAssignment(prop) || !ts.isNoSubstitutionTemplateLiteral(prop.initializer))
				throw Error("shim shape");
			runtimeNames[name(prop.name)] = exportedValues(
				ts.createSourceFile("shim.ts", prop.initializer.text, ts.ScriptTarget.Latest, true),
			);
		}
		expect(Object.keys(runtimeNames).sort()).toEqual([
			"@percho/plugin-api",
			"react",
			"react-dom",
			"react/jsx-runtime",
		]);
		const hostSource = await source("../../renderer/src/plugins/host-api.ts");
		const assignment = find(hostSource, ts.isBinaryExpression).find(
			(node) => node.left.getText() === "window.PerchoUI",
		);
		if (
			!assignment ||
			!ts.isSatisfiesExpression(assignment.right) ||
			!ts.isObjectLiteralExpression(assignment.right.expression)
		)
			throw Error("host shape");
		const hostObject = assignment.right.expression;
		expect(hostObject.properties.map((prop) => name(prop.name))).toEqual([
			"version",
			"React",
			"jsxRuntime",
			"ReactDOM",
			"components",
			"helpers",
			"hooks",
			"stores",
		]);
		const host: Record<string, any> = { version: 1 };
		for (const prop of hostObject.properties) {
			if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
				host[name(prop.name)] = Object.fromEntries(
					prop.initializer.properties.map((item) => [name(item.name), { sentinel: name(item.name) }]),
				);
			}
		}
		for (const [module, group] of [
			["react", "React"],
			["react/jsx-runtime", "jsxRuntime"],
			["react-dom", "ReactDOM"],
		] as const) {
			host[group] = Object.fromEntries(
				required(runtimeNames[module]).map((key) => [key, { sentinel: `${module}/${key}` }]),
			);
		}
		expect(Object.keys(host.components).sort()).toEqual([
			"Button",
			"Dropdown",
			"ImagePreview",
			"Markdown",
			"Tooltip",
		]);
		expect(Object.keys(host.helpers).sort()).toEqual(["displayToolName", "summarizeArgs"]);
		expect(Object.keys(host.hooks).sort()).toEqual(["useContextUsage", "useLanguage", "useQuota", "useT"]);
		expect(Object.keys(host.stores).sort()).toEqual([
			"useProjectsStore",
			"useSessionsStore",
			"useSettingsStore",
			"useTranscriptStore",
			"useUiPreferencesStore",
			"useUiStore",
		]);
		const aliases = find(hostObject, ts.isPropertyAssignment).filter(
			(prop) => name(prop.name) === "ImagePreview" || name(prop.name) === "displayToolName",
		);
		expect(aliases.map((prop) => [name(prop.name), prop.initializer.getText()])).toEqual([
			["ImagePreview", "ImagePreviewOverlay"],
			["displayToolName", "displayName"],
		]);
		expect(runtimeNames["@percho/plugin-api"]).toEqual(
			[
				"version",
				"components",
				"helpers",
				"hooks",
				"stores",
				...Object.keys(host.components),
				...Object.keys(host.helpers),
				...Object.keys(host.hooks),
				...Object.keys(host.stores),
			].sort(),
		);
		const dir = await mkdtemp(join(tmpdir(), "plugin-contract-"));
		try {
			await mkdir(join(dir, "src"));
			await writeFile(
				join(dir, "src/index.ts"),
				`import * as R from "react"; import * as J from "react/jsx-runtime"; import * as D from "react-dom"; import * as A from "@percho/plugin-api"; export const modules = [R,J,D,A];`,
			);
			expect(await buildPlugin(dir, "src/index.ts")).toEqual({ ok: true });
			const built = await readFile(join(dir, "dist/index.js"), "utf8");
			const compiled = await transform(built, { format: "cjs" });
			const module = { exports: {} as { modules: Array<Record<string, unknown>> } };
			new Function("window", "module", "exports", compiled.code)({ PerchoUI: host }, module, module.exports);
			for (const [index, id] of ["react", "react/jsx-runtime", "react-dom", "@percho/plugin-api"].entries()) {
				const exports = required(module.exports.modules[index]);
				expect(
					Object.keys(exports)
						.filter((key) => key !== "default")
						.sort(),
				).toEqual(runtimeNames[id]);
				for (const value of Object.values(exports)) expect(value).toBeDefined();
			}
			expect(required(module.exports.modules[0]).default).toBe(host.React);
			const api = required(module.exports.modules[3]);
			expect(api.Button).toBe(host.components.Button);
			expect(api.ImagePreview).toBe(host.components.ImagePreview);
			expect(api.displayToolName).toBe(host.helpers.displayToolName);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
		const declaration = await source("../../../resources/ui-plugins/percho-ui.d.ts");
		for (const id of Object.keys(runtimeNames)) {
			const decl = find(declaration, ts.isModuleDeclaration).find((node) => name(node.name) === id);
			if (!decl) throw Error(id);
			const gaps = difference(required(runtimeNames[id]), exportedValues(decl));
			expect(gaps).toEqual(
				id === "@percho/plugin-api"
					? [
							"Button",
							"Dropdown",
							"ImagePreview",
							"Markdown",
							"Tooltip",
							"displayToolName",
							"summarizeArgs",
							"useContextUsage",
							"useLanguage",
							"useQuota",
							"useT",
						].sort()
					: [],
			);
		}
	});
	it("slot props and assets cover the declared sets; records three current message-field gaps", async () => {
		const declaration = await source("../../../resources/ui-plugins/percho-ui.d.ts");
		const types = await source("../../../../shared/src/transcript/types.ts");
		expect(interfaceFields(declaration, "SlotProps")).toEqual([...KNOWN_UI_SLOTS].sort());
		expect(KNOWN_UI_REGIONS).toHaveLength(8);
		expect(
			difference(interfaceFields(types, "UIToolCall"), interfaceFields(declaration, "UIToolCall")),
		).toEqual(["diff", "endedAt"]);
		expect(
			difference(interfaceFields(types, "SubagentRunUi"), interfaceFields(declaration, "SubagentRunUi")),
		).toEqual(["thinkingLevel"]);
		const loaders = objectVariable(await source("./build.ts"), "ASSET_LOADERS");
		const declaredAssets = find(declaration, ts.isModuleDeclaration)
			.map((node) => name(node.name))
			.filter((id) => id.startsWith("*."))
			.map((id) => id.slice(1))
			.sort();
		expect(loaders.properties.map((prop) => name(prop.name)).sort()).toEqual(declaredAssets);
		expect(declaredAssets).toEqual([
			".aac",
			".gif",
			".jpeg",
			".jpg",
			".m4a",
			".mp3",
			".ogg",
			".png",
			".wav",
			".webp",
		]);
	});
});
