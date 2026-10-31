import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KNOWN_UI_SLOTS, UI_SLOTS } from "@percho/shared";
import { transform } from "esbuild";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildPlugin } from "./build";

const parse = (text: string) => ts.createSourceFile("contract.ts", text, ts.ScriptTarget.Latest, true);
const source = async (relative: string) => parse(await readFile(new URL(relative, import.meta.url), "utf8"));
function find<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
	const result: T[] = [];
	function visit(node: ts.Node) {
		if (predicate(node)) result.push(node);
		ts.forEachChild(node, visit);
	}
	visit(root);
	return result;
}
function required<T>(value: T | undefined): T {
	if (value === undefined) throw Error("Missing contract value");
	return value;
}
function name(node: ts.Node | undefined): string {
	const value = required(node);
	if (ts.isIdentifier(value) || ts.isStringLiteral(value)) return value.text;
	throw Error(`Unsupported contract name: ${value.getText()}`);
}
function objectVariable(root: ts.SourceFile, variable: string): ts.ObjectLiteralExpression {
	const declaration = find(root, ts.isVariableDeclaration).find((node) => node.name.getText() === variable);
	const value = required(declaration?.initializer);
	if (!ts.isObjectLiteralExpression(value)) throw Error(variable);
	return value;
}
function interfaceNode(root: ts.Node, id: string) {
	return required(find(root, ts.isInterfaceDeclaration).find((node) => node.name.text === id));
}
function moduleNode(root: ts.Node, id: string) {
	return required(find(root, ts.isModuleDeclaration).find((node) => name(node.name) === id));
}
const hasExport = (node: ts.Node) =>
	ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
function exportedValues(root: ts.Node): string[] {
	const result: string[] = [];
	for (const node of find(root, (node): node is ts.Statement => ts.isStatement(node))) {
		if (ts.isExportAssignment(node)) result.push("default");
		else if (
			ts.isExportDeclaration(node) &&
			!node.isTypeOnly &&
			node.exportClause &&
			ts.isNamedExports(node.exportClause)
		) {
			result.push(...node.exportClause.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text));
		} else if (hasExport(node)) {
			if (ts.isVariableStatement(node))
				for (const decl of node.declarationList.declarations) {
					result.push(
						...(ts.isObjectBindingPattern(decl.name)
							? decl.name.elements.map((e) => name(e.name))
							: [name(decl.name)]),
					);
				}
			else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node))
				result.push(name(node.name));
		}
	}
	return result.sort();
}
/** Parse the actual shim's exported name -> host access path, including destructuring aliases. */
function shimExports(text: string): Map<string, string[]> {
	const root = parse(text),
		locals = new Map<string, string[]>(),
		exports = new Map<string, string[]>();
	function path(node: ts.Expression): string[] {
		if (ts.isIdentifier(node)) return required(locals.get(node.text));
		if (ts.isPropertyAccessExpression(node)) {
			if (node.expression.getText() === "window" && node.name.text === "PerchoUI") return [];
			return [...path(node.expression), node.name.text];
		}
		throw Error(`Unsupported shim expression ${node.getText()}`);
	}
	for (const statement of root.statements) {
		if (ts.isVariableStatement(statement))
			for (const declaration of statement.declarationList.declarations) {
				const base = path(required(declaration.initializer));
				if (ts.isIdentifier(declaration.name)) locals.set(declaration.name.text, base);
				else if (ts.isObjectBindingPattern(declaration.name))
					for (const binding of declaration.name.elements) {
						if (binding.dotDotDotToken || binding.initializer)
							throw Error("Unsupported shim rest/default binding");
						locals.set(name(binding.name), [...base, name(binding.propertyName ?? binding.name)]);
					}
				else throw Error("Unsupported shim binding");
				if (hasExport(statement))
					for (const key of ts.isObjectBindingPattern(declaration.name)
						? declaration.name.elements.map((b) => name(b.name))
						: [name(declaration.name)])
						exports.set(key, required(locals.get(key)));
			}
		else if (ts.isExportAssignment(statement)) exports.set("default", path(statement.expression));
		else if (
			ts.isExportDeclaration(statement) &&
			statement.exportClause &&
			ts.isNamedExports(statement.exportClause)
		) {
			for (const binding of statement.exportClause.elements)
				exports.set(binding.name.text, required(locals.get(name(binding.propertyName ?? binding.name))));
		} else throw Error(`Unsupported shim statement ${statement.getText()}`);
	}
	return exports;
}
const sortedMap = (map: Map<string, string[]>) => [...map].sort(([a], [b]) => a.localeCompare(b));
async function contracts() {
	const build = await source("./build.ts"),
		hostSource = await source("../../renderer/src/plugins/host-api.ts");
	const shims = Object.fromEntries(
		objectVariable(build, "SHIMS").properties.map((prop) => {
			if (!ts.isPropertyAssignment(prop) || !ts.isNoSubstitutionTemplateLiteral(prop.initializer))
				throw Error("Unsupported SHIMS entry");
			return [name(prop.name), prop.initializer.text];
		}),
	);
	const assignment = required(
		find(hostSource, ts.isBinaryExpression).find((node) => node.left.getText() === "window.PerchoUI"),
	);
	if (
		!ts.isSatisfiesExpression(assignment.right) ||
		!ts.isObjectLiteralExpression(assignment.right.expression)
	)
		throw Error("host must retain satisfies");
	const groups: Record<string, Record<string, string>> = {};
	const host = assignment.right.expression;
	for (const prop of host.properties)
		if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
			groups[name(prop.name)] = Object.fromEntries(
				prop.initializer.properties.map((item) => {
					if (ts.isShorthandPropertyAssignment(item)) return [name(item.name), name(item.name)];
					if (ts.isPropertyAssignment(item) && ts.isIdentifier(item.initializer))
						return [name(item.name), item.initializer.text];
					throw Error("Unsupported host group binding");
				}),
			);
		}
	const namespaces = Object.fromEntries(
		find(hostSource, ts.isImportDeclaration).flatMap((node) =>
			node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)
				? [[node.importClause.namedBindings.name.text, name(node.moduleSpecifier)]]
				: [],
		),
	);
	const expected = new Map<string, string[]>([
		["default", []],
		["version", ["version"]],
	]);
	for (const [group, bindings] of Object.entries(groups)) {
		expected.set(group, [group]);
		for (const key of Object.keys(bindings)) {
			if (expected.has(key)) throw Error(`Duplicate flattened host export ${key}`);
			expected.set(key, [group, key]);
		}
	}
	return {
		build,
		host,
		groups,
		namespaces,
		expected,
		shims,
		declaration: await source("../../../resources/ui-plugins/percho-ui.d.ts"),
		env: await source("../../renderer/src/plugins/env.d.ts"),
	};
}
function checkSurface(
	data: Awaited<ReturnType<typeof contracts>>,
	shims = data.shims,
	declaration = data.declaration,
) {
	expect(sortedMap(shimExports(required(shims["@percho/plugin-api"])))).toEqual(sortedMap(data.expected));
	const declaredModules = find(declaration, ts.isModuleDeclaration)
		.map((node) => name(node.name))
		.filter((id) => !id.startsWith("*."));
	expect(declaredModules.sort()).toEqual(Object.keys(shims).sort());
	for (const [id, text] of Object.entries(shims)) {
		const bindings = shimExports(text);
		expect(exportedValues(moduleNode(declaration, id))).toEqual([...bindings.keys()].sort());
		if (id !== "@percho/plugin-api") {
			const namespace = required([...bindings.values()][0]?.[0]);
			expect(data.namespaces[namespace]).toBe(id);
			for (const [key, path] of bindings)
				expect(path).toEqual(key === "default" ? [namespace] : [namespace, key]);
		}
	}
	const env = interfaceNode(data.env, "PerchoUiApi");
	expect(env.members.map((member) => name(member.name)).sort()).toEqual(
		data.host.properties.map((prop) => name(prop.name)).sort(),
	);
	const apiModule = moduleNode(declaration, "@percho/plugin-api");
	const publishedValues = find(apiModule, ts.isVariableDeclaration);
	for (const [key, path] of data.expected)
		if (path.length === 2) {
			const flat = required(publishedValues.find((node) => name(node.name) === key));
			if (path[0] === "stores") expect(flat.type?.kind).toBe(ts.SyntaxKind.UnknownKeyword);
			else {
				if (!flat.type || !ts.isTypeQueryNode(flat.type))
					throw Error("flat declaration must reuse group type");
				expect(flat.type.exprName.getText()).toBe(path.join("."));
			}
		}
	for (const [group, bindings] of Object.entries(data.groups)) {
		const envGroup = required(env.members.find((member) => name(member.name) === group));
		if (!ts.isPropertySignature(envGroup) || !envGroup.type || !ts.isTypeLiteralNode(envGroup.type))
			throw Error("env group shape");
		expect(envGroup.type.members.map((member) => name(member.name)).sort()).toEqual(
			Object.keys(bindings).sort(),
		);
		for (const member of envGroup.type.members) {
			if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeQueryNode(member.type))
				throw Error("env binding type");
			expect(member.type.exprName.getText()).toBe(bindings[name(member.name)]);
		}
		const publishedGroup = required(
			find(apiModule, ts.isVariableDeclaration).find((node) => name(node.name) === group),
		);
		if (!publishedGroup.type || !ts.isTypeLiteralNode(publishedGroup.type))
			throw Error("published group shape");
		expect(publishedGroup.type.members.map((member) => name(member.name)).sort()).toEqual(
			Object.keys(bindings).sort(),
		);
		if (group === "stores")
			for (const member of publishedGroup.type.members) {
				if (!ts.isPropertySignature(member)) throw Error("store declaration shape");
				expect(member.type?.kind).toBe(ts.SyntaxKind.UnknownKeyword);
			}
	}
}
function typeTokens(type: ts.TypeNode) {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, type.getText());
	const tokens: Array<string | number> = [];
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
		tokens.push(
			kind,
			kind === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText(),
		);
	return tokens;
}
function fields(root: ts.Node, id: string) {
	return interfaceNode(root, id)
		.members.map((member) => {
			if (!ts.isPropertySignature(member) || !member.type) throw Error(`Unsupported DTO member ${id}`);
			let key: string;
			if (member.name && ts.isComputedPropertyName(member.name)) {
				const access = member.name.expression;
				if (!ts.isPropertyAccessExpression(access) || access.expression.getText() !== "UI_SLOTS")
					throw Error("Slot key expression");
				key = UI_SLOTS[name(access.name) as keyof typeof UI_SLOTS];
			} else key = name(member.name);
			return [key, !!member.questionToken, typeTokens(member.type)];
		})
		.sort(([a], [b]) => String(a).localeCompare(String(b)));
}

describe("V07 complete plugin contract guard (no import of side-effectful host API)", () => {
	it("host groups/aliases, env, four shims and published exports agree bidirectionally", async () => {
		const data = await contracts();
		checkSurface(data);
		// Historical alias/version compatibility data; not a second runtime export list.
		expect(data.groups.components?.ImagePreview).toBe("ImagePreviewOverlay");
		expect(data.groups.helpers?.displayToolName).toBe("displayName");
		const version = required(data.host.properties.find((prop) => name(prop.name) === "version"));
		if (!ts.isPropertyAssignment(version)) throw Error("version shape");
		expect(version.initializer.getText()).toBe("1");
	});
	it("rejects missing/extra exports, wrong same-name alias, wrong group and declaration drift", async () => {
		const data = await contracts(),
			api = required(data.shims["@percho/plugin-api"]);
		for (const replacement of [
			api.replace("Button, Dropdown", "Dropdown"),
			`${api}\nexport const Phantom = A.components.Button;`,
			api.replace("Button, Dropdown", "Dropdown: Button, Dropdown"),
			api.replace("= A.components", "= A.helpers"),
		]) {
			expect(replacement).not.toBe(api);
			expect(() => checkSurface(data, { ...data.shims, "@percho/plugin-api": replacement })).toThrow();
		}
		const react = required(data.shims.react);
		expect(() =>
			checkSurface(data, {
				...data.shims,
				react: react.replace("useState,", "useReducer: useState,"),
			}),
		).toThrow();
		expect(() =>
			checkSurface({
				...data,
				env: parse(
					data.env.text.replace("ImagePreview: typeof ImagePreviewOverlay", "ImagePreview: typeof Markdown"),
				),
			}),
		).toThrow();
		expect(() =>
			checkSurface(
				data,
				data.shims,
				parse(data.declaration.text.replace("export const Button: typeof components.Button;", "")),
			),
		).toThrow();
		expect(() =>
			checkSurface(
				data,
				data.shims,
				parse(data.declaration.text.replace("typeof components.Button;", "typeof components.Dropdown;")),
			),
		).toThrow();
		expect(() =>
			checkSurface(
				data,
				data.shims,
				parse(
					data.declaration.text.replace(
						"export const version: number;",
						"export const version: number; export const Phantom: unknown;",
					),
				),
			),
		).toThrow();
	});
	it("slot prop signatures and DTO fields/types/optionality exactly match; assets cover loader extensions", async () => {
		const data = await contracts(),
			types = await source("../../../../shared/src/transcript/types.ts");
		const slots = await source("../../renderer/src/plugins/slots.ts");
		const spec = await readFile(new URL("../../../resources/ui-plugins/SPEC.md", import.meta.url), "utf8");
		const snippets = parse(
			spec
				.split("```ts")
				.slice(1)
				.map((block) => block.split("```")[0])
				.join("\n"),
		);
		expect(fields(slots, "SlotPropsMap")).toEqual(fields(data.declaration, "SlotProps"));
		expect(
			fields(data.declaration, "SlotProps")
				.map(([key]) => key)
				.sort(),
		).toEqual([...KNOWN_UI_SLOTS].sort());
		for (const id of ["UIToolCall", "SubagentRunUi"]) {
			expect(fields(types, id)).toEqual(fields(data.declaration, id));
			expect(fields(types, id)).toEqual(fields(snippets, id));
			expect(() =>
				expect(fields(types, id)).toEqual(
					fields(
						parse(
							data.declaration.text
								.replace("thinkingLevel?: string;", "thinkingLevel?: number;")
								.replace("endedAt?: number;", "endedAt: number;"),
						),
						id,
					),
				),
			).toThrow();
		}
		const summary = await source("../../../../shared/src/subagent.ts");
		expect(fields(summary, "SubagentRunSummary")).toEqual(fields(data.declaration, "SubagentRunSummary"));
		expect(fields(summary, "SubagentRunSummary")).toEqual(fields(snippets, "SubagentRunSummary"));
		const assets = objectVariable(data.build, "ASSET_LOADERS")
			.properties.map((prop) => name(prop.name))
			.sort();
		const declared = find(data.declaration, ts.isModuleDeclaration)
			.map((node) => name(node.name))
			.filter((id) => id.startsWith("*."))
			.map((id) => id.slice(1))
			.sort();
		expect(assets).toEqual(declared);
	});
	it("published standalone declarations really typecheck and expose exactly the shim value symbols", async () => {
		const data = await contracts();
		const dir = await mkdtemp(join(tmpdir(), "plugin-declaration-"));
		try {
			const fixture = join(dir, "consumer.ts");
			const assets = objectVariable(data.build, "ASSET_LOADERS").properties.map((prop) => name(prop.name));
			const assetChecks = assets.map(
				(ext, index) =>
					`import asset${index} from "./fixture${ext}"; const url${index}: string = asset${index};`,
			);
			const aliases = [...data.expected]
				.filter(([, path]) => path.length === 2 && path[0] !== "stores")
				.map(([key, path], index) => `const alias${index}: typeof A.${path.join(".")} = A.${key};`);
			await writeFile(
				fixture,
				`import * as A from "@percho/plugin-api";\n${aliases.join("\n")}\n${assetChecks.join("\n")}\ndeclare const tool: A.UIToolCall; declare const run: A.SubagentRunUi;\nconst end: number | undefined = tool.endedAt; const diff: string | undefined = tool.diff;\nconst thinking: string | undefined = run.thinkingLevel; const store: unknown = A.useProjectsStore;`,
			);
			const declaration = new URL("../../../resources/ui-plugins/percho-ui.d.ts", import.meta.url).pathname;
			const program = ts.createProgram([fixture, declaration], {
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				target: ts.ScriptTarget.ESNext,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				types: [],
			});
			expect(
				ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
			).toEqual([]);
			const checker = program.getTypeChecker(),
				published = required(program.getSourceFile(resolve(declaration)));
			for (const id of Object.keys(data.shims)) {
				const symbol = required(checker.getSymbolAtLocation(moduleNode(published, id).name));
				const values = checker
					.getExportsOfModule(symbol)
					.filter((value) => {
						const target = value.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value;
						return !!(target.flags & ts.SymbolFlags.Value);
					})
					.map((value) => value.name)
					.sort();
				expect(values).toEqual([...shimExports(required(data.shims[id])).keys()].sort());
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 20000);
	it("builds real all-specifier shims and every asset, and checks every export's actual identity", async () => {
		const data = await contracts();
		const host: Record<string, any> = { version: 1, React, jsxRuntime, ReactDOM };
		for (const [group, entries] of Object.entries(data.groups))
			host[group] = Object.fromEntries(
				Object.entries(entries).map(([key, binding]) => [key, { group, binding }]),
			);
		const dir = await mkdtemp(join(tmpdir(), "plugin-contract-"));
		try {
			await mkdir(join(dir, "src"));
			const ids = Object.keys(data.shims),
				assets = objectVariable(data.build, "ASSET_LOADERS").properties.map((prop) => name(prop.name));
			for (const ext of assets) await writeFile(join(dir, `src/fixture${ext}`), Buffer.from("fixture"));
			await writeFile(
				join(dir, "src/index.ts"),
				`${ids.map((id, index) => `import * as M${index} from ${JSON.stringify(id)};`).join("\n")}\n${assets.map((ext, index) => `import A${index} from "./fixture${ext}";`).join("\n")}\nexport const modules = [${ids.map((_, i) => `M${i}`).join(",")}]; export const assets = [${assets.map((_, i) => `A${i}`).join(",")}];`,
			);
			expect(await buildPlugin(dir, "src/index.ts")).toEqual({ ok: true });
			const built = await readFile(join(dir, "dist/index.js"), "utf8"),
				compiled = await transform(built, { format: "cjs" });
			const module = { exports: {} as { modules: Array<Record<string, unknown>>; assets: string[] } };
			new Function("window", "module", "exports", compiled.code)({ PerchoUI: host }, module, module.exports);
			for (const [index, id] of ids.entries()) {
				const actual = required(module.exports.modules[index]);
				expect(Object.keys(actual).sort()).toEqual([...shimExports(required(data.shims[id])).keys()].sort());
				for (const [key, path] of shimExports(required(data.shims[id]))) {
					let expected: any = host;
					for (const segment of path) expected = expected[segment];
					expect(expected, `${id}/${key}`).toBeDefined();
					expect(actual[key]).toBe(expected);
				}
			}
			expect(module.exports.assets).toHaveLength(assets.length);
			for (const url of module.exports.assets) expect(url.startsWith("data:")).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
