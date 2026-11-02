import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";

const log = createLogger("media-fork");

import { privateDirectory } from "../storage/private-directory";
import { collectSessionAssets } from "./media-entries";
import type { SessionMediaStore } from "./media-store";

/** SDK内存分叉决定保留的整棵记录；不修改注册source manager，也不提前发布到历史目录。 */
export async function prepareMediaFork(
	source: SessionManager,
	sourceFile: string,
	leafId: string,
	media: SessionMediaStore,
	stagingRoot: string,
	canPublish: () => boolean = () => true,
): Promise<string> {
	const header = source.getHeader();
	if (!header) throw new Error("Source session header is unavailable");
	const fork = SessionManager.inMemory(
		source.getCwd(),
		undefined,
		structuredClone([header, ...source.getEntries()]),
	);
	fork.createBranchedSession(leafId);
	const id = fork.getSessionId(),
		newHeader = fork.getHeader();
	if (!newHeader || id === source.getSessionId()) throw new Error("SDK did not create an independent fork");
	const entries = fork.getEntries(),
		assets = collectSessionAssets(entries);
	const root = resolve(stagingRoot);
	if ((await realpath(dirname(root))) !== dirname(root))
		throw new Error("Linked fork staging parent is not allowed");
	let created = false;
	try {
		await mkdir(root, { mode: 0o700 });
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root)
		throw new Error("Linked fork staging root is not allowed");
	await privateDirectory(root, created);
	const directory = await mkdtemp(join(root, "fork-"));
	await privateDirectory(directory, true);
	const name = `${Date.now()}_${id}.jsonl`,
		staged = join(directory, name),
		target = join(dirname(sourceFile), name);
	const manifest = new JsonStore<{
		version: 1;
		phase: "preparing" | "ready" | "committed";
		source: string;
		target: string;
		owner: string;
	} | null>({ path: join(directory, "fork.json"), defaultValue: () => null, mode: 0o600, durable: true });
	let published = false,
		alive = true;
	const identity = {};
	media.openOwner(id, identity);
	try {
		const lease = media.lease(id, () => alive && canPublish());
		await manifest.write({ version: 1, phase: "preparing", source: sourceFile, target, owner: id });
		for (const asset of assets) await media.copyAsset(source.getSessionId(), lease, asset.id, asset.revision);
		lease.assert();
		// parentSession指向真正的来源文件，绝不留下临时目录作为父会话。
		const handle = await open(staged, "wx", 0o600);
		try {
			await handle.writeFile(
				`${[{ ...newHeader, parentSession: sourceFile }, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await manifest.write({ version: 1, phase: "ready", source: sourceFile, target, owner: id });
		// 文件名含新的SDK UUID；最后一步才对普通历史列表可见。
		lease.assert();
		try {
			await rename(staged, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			const local = `${target}.pending`;
			try {
				await copyFile(staged, local, constants.COPYFILE_EXCL);
				const file = await open(local, "r+");
				try {
					await file.sync();
				} finally {
					await file.close();
				}
				lease.assert();
				await rename(local, target);
			} finally {
				await rm(local, { force: true });
			}
		}
		published = true;
		if (process.platform !== "win32") {
			const parent = await open(dirname(target), "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		}
		// 发布之后已经是完整可用分叉；不能因附属清单写失败回滚他人可能已经打开的文件。
		await manifest
			.write({ version: 1, phase: "committed", source: sourceFile, target, owner: id })
			.catch((error) =>
				log.warn("Fork published, final manifest write failed", { owner: id, error: String(error) }),
			);
		return target;
	} finally {
		alive = false;
		media.closeOwner(id, identity);
		if (!published) await media.deleteOwner(id);
		// 崩溃时留下的preparing/ready只在private staging下，不是可见的半成品JSONL。
		await rm(directory, { recursive: true, force: true });
	}
}
