import { readFileSync } from "node:fs";
import { isSupportedRuntimeNode, RUNTIME_NODE_RANGE } from "@percho/shared";
import { expect, it } from "vitest";

it("keeps the runtime minimum aligned with the pinned SDK without a major-version ceiling", () => {
	const sdk = JSON.parse(
		readFileSync(
			new URL("../../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
			"utf8",
		),
	);
	expect(RUNTIME_NODE_RANGE).toBe(sdk.engines.node);
	for (const version of ["22.19.0", "22.23.4", "24.22.1", "26.12.1"])
		expect(isSupportedRuntimeNode(version)).toBe(true);
	for (const version of ["20.20.2", "22.18.9", "22.19.0-rc.1", "26.12", "garbage", "26.12.NaN"])
		expect(isSupportedRuntimeNode(version)).toBe(false);
});
