import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateProjectDirectory } from "../src/project/directory";

let root: string;
beforeAll(async () => {
	const parent = resolve("../../.local/tmp/ssh-remote-runtime/directory-tests");
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(`${parent}/project-`);
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});
describe("literal project directories", () => {
	it("preserves percent escapes, quotes, shell syntax, anchors and whitespace as literal filenames", async () => {
		const path = `${root}/ 中文 %2F [notes] $(literal) ' :12 `;
		await mkdir(path);
		expect(await validateProjectDirectory(path)).toBe(await realpath(path));
		await expect(validateProjectDirectory(path.trim())).rejects.toThrow();
	});
	it("canonicalizes a symlink and rejects files, missing paths and relative input without creating anything", async () => {
		await mkdir(`${root}/target`);
		await symlink(`${root}/target`, `${root}/link`);
		expect(await validateProjectDirectory(`${root}/link`)).toBe(await realpath(`${root}/target`));
		await writeFile(`${root}/regular`, "fixture");
		await expect(validateProjectDirectory(`${root}/regular`)).rejects.toThrow("directory");
		await expect(validateProjectDirectory(`${root}/missing`)).rejects.toThrow();
		await expect(validateProjectDirectory("relative")).rejects.toThrow("absolute");
		await expect(validateProjectDirectory("/bad\0path")).rejects.toThrow("absolute");
	});
	it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
		"rejects unreadable or unsearchable directories using actual OS permissions",
		async () => {
			const path = `${root}/private`;
			await mkdir(path);
			await chmod(path, 0);
			try {
				await expect(validateProjectDirectory(path)).rejects.toThrow();
			} finally {
				await chmod(path, 0o700);
			}
		},
	);
});
