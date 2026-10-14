import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Production-only relative module graph, including declarations/type imports. This stays in the
// existing Vitest-discovered test path; graph parsing never executes Electron or renderer modules.
const DOMAINS = [
	{ name: "main", root: resolve(__dirname, "../../main") },
	{ name: "preload", root: resolve(__dirname, "../../preload") },
	{ name: "renderer", root: __dirname },
];
function sourcesIn(root: string): Map<string, string> {
	const sources = new Map<string, string>();
	function walk(dir: string) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const file = join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (/\.(?:[cm]?ts|tsx)$/.test(file) && !/\.test\.(?:[cm]?ts|tsx)$/.test(file)) {
				sources.set(file, readFileSync(file, "utf8"));
			}
		}
	}
	walk(root);
	return sources;
}
function importSpecifiers(file: string, text: string): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const specs: string[] = [];
	function literal(node: ts.Node | undefined) {
		if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) specs.push(node.text);
	}
	function visit(node: ts.Node) {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal(node.moduleSpecifier);
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
			literal(node.arguments[0]);
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal(node.argument.literal);
		if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
			literal(node.moduleReference.expression);
		ts.forEachChild(node, visit);
	}
	visit(source);
	return specs;
}
function buildGraph(sources: Map<string, string>) {
	const graph = new Map<string, string[]>();
	let parsedSpecifiers = 0;
	for (const [file, text] of sources) {
		const specs = importSpecifiers(file, text);
		parsedSpecifiers += specs.length;
		const edges: string[] = [];
		for (const spec of specs) {
			if (!spec.startsWith(".")) continue;
			const path = resolve(dirname(file), spec.split("?")[0] ?? spec);
			const stem = path.replace(/\.(?:mjs|cjs|jsx|js)$/, "");
			const suffixes = path.endsWith(".mjs")
				? [".mts", ".d.mts"]
				: path.endsWith(".cjs")
					? [".cts", ".d.cts"]
					: path.endsWith(".jsx")
						? [".tsx", ".d.ts"]
						: [".ts", ".tsx", ".d.ts"];
			const target = [
				path,
				...suffixes.map((suffix) => `${stem}${suffix}`),
				join(path, "index.ts"),
				join(path, "index.tsx"),
				join(path, "index.d.ts"),
			].find((candidate) => sources.has(candidate));
			if (target) edges.push(target);
		}
		graph.set(file, [...new Set(edges)]);
	}
	return {
		graph,
		parsedSpecifiers,
		edgeCount: [...graph.values()].reduce((sum, edges) => sum + edges.length, 0),
	};
}
function cyclesIn(graph: Map<string, string[]>): string[][] {
	const active = new Set<string>();
	const done = new Set<string>();
	const stack: string[] = [];
	const cycles: string[][] = [];
	function visit(node: string) {
		active.add(node);
		stack.push(node);
		for (const target of graph.get(node) ?? []) {
			if (active.has(target)) cycles.push([...stack.slice(stack.indexOf(target)), target]);
			else if (!done.has(target)) visit(target);
		}
		stack.pop();
		active.delete(node);
		done.add(node);
	}
	for (const node of graph.keys()) if (!done.has(node)) visit(node);
	return cycles;
}
function fixture(domain: string, sources: Record<string, string>) {
	const root = resolve("/virtual", domain);
	const result = buildGraph(new Map(Object.entries(sources).map(([name, text]) => [join(root, name), text])));
	return {
		...result,
		root,
		cycles: cyclesIn(result.graph).map((cycle) => cycle.map((file) => relative(root, file))),
	};
}
const actual = DOMAINS.map((domain) => ({ ...domain, ...buildGraph(sourcesIn(domain.root)) }));

describe("main/preload/renderer production relative imports are acyclic", () => {
	it.each(actual)("$name is really scanned and has no cycles", (domain) => {
		expect(domain.graph.size, `${domain.name}: source glob is empty`).toBeGreaterThan(0);
		expect(domain.parsedSpecifiers, `${domain.name}: no actual imports parsed`).toBeGreaterThan(0);
		expect(
			cyclesIn(domain.graph).map((cycle) => cycle.map((file) => relative(domain.root, file)).join(" → ")),
		).toEqual([]);
	});
	it("combined production graphs have actual resolved edges; single-file preload may legitimately have zero", () => {
		expect(actual.reduce((sum, domain) => sum + domain.edgeCount, 0)).toBeGreaterThan(0);
		for (const domain of actual) {
			expect([...domain.graph.keys()].some((file) => /\.test\./.test(file))).toBe(false);
			console.info(
				`import graph ${domain.name}: ${domain.graph.size} sources, ${domain.edgeCount} relative edges, ${domain.parsedSpecifiers} parsed specifiers`,
			);
		}
	});
});

describe("same graph parser counterexamples (including preload-style relative cycles)", () => {
	it.each(DOMAINS)(
		"$name detects both self-loop and multi-node type/barrel/side-effect cycle",
		({ name }) => {
			expect(fixture(name, { "index.ts": 'import "./index";' }).cycles).toEqual([["index.ts", "index.ts"]]);
			expect(
				fixture(name, {
					"a.ts": 'import type { T } from "./b";',
					"b.ts": 'export { x } from "./c";',
					"c.ts": 'import "./a";',
				}).cycles,
			).toEqual([["a.ts", "b.ts", "c.ts", "a.ts"]]);
		},
	);
	it.each(DOMAINS)(
		"$name correctly resolves a real acyclic grammar fixture, declarations, barrels and JS-to-TS",
		({ name }) => {
			const example = fixture(name, {
				"index.ts": `import type { T } from "./types"; import "./boot.js";
				export { x } from "./folder"; import "./folder/index.js";
					const lazy = import("./lazy"); type U = import("./types").T;
				// import "./index";
				const notAnImport = 'import "./index"';`,
				"types.d.ts": "export type T = string;",
				"boot.ts": "export {};",
				"folder/index.tsx": "export const x = 1;",
				"lazy.ts": "export {};",
			});
			expect(example.graph.size).toBe(5);
			expect(example.parsedSpecifiers).toBe(6);
			expect(example.edgeCount).toBe(4);
			expect(
				example.graph.get(join(example.root, "index.ts"))?.map((file) => relative(example.root, file)),
			).toEqual(["types.d.ts", "boot.ts", "folder/index.tsx", "lazy.ts"]);
			expect(example.cycles).toEqual([]);
		},
	);
});
