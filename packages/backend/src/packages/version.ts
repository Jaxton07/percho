import gt from "semver/functions/gt.js";
import valid from "semver/functions/valid.js";

export function isNewerVersion(latest: string, installed: string): boolean {
	return Boolean(valid(latest) && valid(installed) && gt(latest, installed));
}
