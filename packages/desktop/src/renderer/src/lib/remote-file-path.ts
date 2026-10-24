/** Remote tool paths are literal POSIX paths, never local paths or filesystem probes. */
export function remoteFilePath(target: string, cwd: string, fileUrl = false): string {
	if (fileUrl && /^file:\/\//i.test(target)) {
		const url = new URL(target);
		if (url.hostname && url.hostname !== "localhost") throw new Error("Unsupported file URL host");
		target = decodeURIComponent(url.pathname);
	}
	if (target.includes("\0")) throw new Error("Invalid file path");
	// Home-relative paths cannot be expanded from the desktop's home directory.
	if (target === "~" || target.startsWith("~/")) return target;
	if (!cwd.startsWith("/")) throw new Error("Missing remote working directory");
	const segments: string[] = [];
	for (const part of (target.startsWith("/") ? target : `${cwd}/${target}`).split("/")) {
		if (part === "..") segments.pop();
		else if (part && part !== ".") segments.push(part);
	}
	return `/${segments.join("/")}`;
}
