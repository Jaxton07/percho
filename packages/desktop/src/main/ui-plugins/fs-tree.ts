import { cp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@percho/backend";

const log = createLogger("ui-plugins");

/** 目录级拷贝：递归比较（文件逐字节、目录递归），内容一致则跳过；返回是否成功（失败告警） */
export async function copyTree(src: string, dst: string): Promise<boolean> {
	try {
		const srcStat = await stat(src);
		if (srcStat.isDirectory()) {
			const [srcEntries, dstExists] = await Promise.all([readdir(src), stat(dst).catch(() => null)]);
			if (dstExists?.isDirectory()) {
				let allSame = true;
				for (const entry of srcEntries) {
					if (!(await sameTree(join(src, entry), join(dst, entry)))) {
						allSame = false;
						break;
					}
				}
				if (allSame) return true;
			}
			await rm(dst, { recursive: true, force: true });
			await cp(src, dst, { recursive: true });
			return true;
		}
		return true; // 非目录源（文件/其他）无整树可拷，视为无事可做
	} catch (err) {
		log.error("copyTree failed", src, err);
		return false;
	}
}

/** 递归一致性比较：文件逐字节、目录递归、缺失/类型不同视为不一致（不再对目录 readFile 抛 EISDIR） */
export async function sameTree(a: string, b: string): Promise<boolean> {
	const [sa, sb] = await Promise.all([stat(a), stat(b).catch(() => null)]);
	if (!sb || sa.isDirectory() !== sb.isDirectory()) return false;
	if (sa.isFile()) {
		const [fa, fb] = await Promise.all([readFile(a), readFile(b)]);
		return fa.equals(fb);
	}
	if (sa.isDirectory()) {
		const [ea, eb] = await Promise.all([readdir(a), readdir(b)]);
		if (ea.length !== eb.length) return false;
		for (const entry of ea) {
			if (!eb.includes(entry)) return false;
			if (!(await sameTree(join(a, entry), join(b, entry)))) return false;
		}
		return true;
	}
	return false; // 其它类型（symlink 等）视为不一致，重拷
}

/** 目录内所有文件的最新 mtime（构建陈旧性判断：源码比产物新即重建） */
export async function newestMtime(dir: string): Promise<number | null> {
	let newest: number | null = null;
	const walk = async (d: string) => {
		const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) {
				await walk(p);
			} else {
				const s = await stat(p).catch(() => null);
				if (s && (newest === null || s.mtimeMs > newest)) newest = s.mtimeMs;
			}
		}
	};
	await walk(dir);
	return newest;
}
