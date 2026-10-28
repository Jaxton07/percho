import policy from "./runtime-node-policy.json";

/** Same minimum as the pinned SDK. Tested releases are recorded separately from the accepted range. */
export const RUNTIME_NODE_RANGE = policy.node;
export function isSupportedRuntimeNode(version: string): boolean {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
	const actual = version.split(".").map(Number);
	if (!actual.every(Number.isSafeInteger)) return false;
	const minimum = RUNTIME_NODE_RANGE.slice(2).split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
		if (difference !== 0) return difference > 0;
	}
	return true;
}
