import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SourceSnapshot } from "./source-snapshot";

const execute = promisify(execFile);
async function sdkPackage(): Promise<{ root: string; bin: string }> {
	// getPackageDir可以指向仅含文档/模板的Percho资源包；CLI应定位当前实际安装包的公开bin。
	const name = "@earendil-works/pi-coding-agent";
	for (const location of createRequire(import.meta.url).resolve.paths(name) ?? []) {
		const root = join(location, name);
		let manifest: { name?: string; bin?: string | { pi?: string } } | undefined;
		try {
			manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (manifest?.name !== name) continue;
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
		if (!bin) throw new Error("SDK export command is unavailable");
		return { root, bin: resolve(root, bin) };
	}
	throw new Error("SDK package is unavailable");
}
/** 显式导出时调用SDK公开CLI，不为检视页创建AgentSession，也不让SDK迁移原文件。 */
export async function exportReadOnlyHtml(snapshot: SourceSnapshot, output: string): Promise<string> {
	if (!snapshot.header) throw new Error("Read-only export has no session header");
	const directory = dirname(output),
		candidate = join(directory, "source.staging");
	await writeFile(
		candidate,
		`${[snapshot.header, ...snapshot.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	const sdk = await sdkPackage();
	try {
		await execute(process.execPath, [sdk.bin, "--export", candidate, output], {
			cwd: directory,
			timeout: 30000,
			maxBuffer: 1024 * 1024,
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1",
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				PERCHO_AGENT_DIR: join(directory, "agent"),
				PI_PACKAGE_DIR: sdk.root,
			},
		});
	} catch {
		throw new Error("SDK read-only HTML export failed");
	}
	return output;
}
