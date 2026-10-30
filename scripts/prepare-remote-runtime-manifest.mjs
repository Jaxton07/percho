import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { currentRelease } from "./release/plan.mjs";
import { prepareRuntimeManifest } from "./release/runtime-manifest.mjs";

const { values } = parseArgs({
	options: {
		input: { type: "string" },
		output: { type: "string" },
		version: { type: "string" },
		"require-published": { type: "boolean", default: false },
	},
});
if (!values.input || !values.output)
	throw new Error("Expected --input <artifact-directory> --output <desktop-manifest>");
const release = await currentRelease({ version: values.version });
await prepareRuntimeManifest(
	resolve(values.input),
	resolve(values.output),
	release,
	values["require-published"],
);
console.log(JSON.stringify({ prepared: true, ...release }));
