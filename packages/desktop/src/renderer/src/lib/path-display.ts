import { environmentEntityRef } from "@percho/shared";

/** Decode only UI identity references; literal tool paths remain displayable. */
export function displayPath(path: string): string {
	try {
		return environmentEntityRef(path).id;
	} catch {
		return path;
	}
}

/** 仅用于展示：兼容 POSIX/Windows 分隔符，不修改用于导航、分组或 IO 的原始路径。 */
export function pathLastSegment(path: string): string | undefined {
	return displayPath(path).split(/[\\/]/).filter(Boolean).pop();
}
