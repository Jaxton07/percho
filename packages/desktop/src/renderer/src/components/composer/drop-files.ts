/**
 * Resolve native paths for files dropped into the sandboxed renderer.
 * Electron can return an empty path for JS-created File objects, so those are ignored.
 */
export function resolveDroppedFilePaths(
	files: ArrayLike<unknown>,
	getPathForFile: (file: unknown) => string,
): string[] {
	const paths = new Set<string>();
	for (const file of Array.from(files)) {
		try {
			const path = getPathForFile(file);
			if (path.length > 0) paths.add(path);
		} catch {
			// Ignore values that are not native File objects instead of breaking the drop event.
		}
	}
	return [...paths];
}
