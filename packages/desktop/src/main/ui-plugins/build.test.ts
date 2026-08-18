// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPlugin } from "./build";

const tmpDirs: string[] = [];

async function makePlugin(src: string, main = "src/index.tsx"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ui-plugin-test-"));
	tmpDirs.push(dir);
	await mkdir(join(dir, "src"), { recursive: true });
	await writeFile(join(dir, main), src, "utf-8");
	return dir;
}

afterEach(async () => {
	await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ui-plugins build", () => {
	it("引用 react 的 tsx 构建成功，产物无裸导入（已重写为 window.PerchoUI shim）", async () => {
		const dir = await makePlugin(`
import { useState } from "react";
import { Button, useT } from "@percho/plugin-api";

export function ToolCallCard({ tool }: { tool: { name: string } }) {
	const [n, setN] = useState(0);
	const t = useT();
	return <Button onClick={() => setN(n + 1)}>{t("message.thinking")}{tool.name}{n}</Button>;
}
`);
		const res = await buildPlugin(dir, "src/index.tsx");
		expect(res).toEqual({ ok: true });
		const out = await readFile(join(dir, "dist/index.js"), "utf-8");
		// 产物是自包含 ESM：无 require、无任何裸 import（react/plugin-api 已被重写成 shim）
		expect(out).not.toContain("require(");
		expect(out).not.toContain('from "react"');
		expect(out).not.toContain('from "@percho/plugin-api"');
		// shim 确实以 window.PerchoUI 为源；JSX 经 automatic runtime → 被重写的 jsx-runtime
		expect(out).toContain("window.PerchoUI");
		expect(out).toContain("window.PerchoUI.jsxRuntime");
	});

	it("jsx automatic 产物使用被重写的 jsx-runtime（无 react/jsx-runtime 裸导入）", async () => {
		const dir = await makePlugin(`
export function Card() { return <div className="x">hi</div>; }
`);
		const res = await buildPlugin(dir, "src/index.tsx");
		expect(res).toEqual({ ok: true });
		const out = await readFile(join(dir, "dist/index.js"), "utf-8");
		expect(out).not.toContain('from "react/jsx-runtime"');
		expect(out).toContain("window.PerchoUI.jsxRuntime");
	});

	it("图片资产经 dataurl loader 内联（data:image/png;base64 进产物）", async () => {
		// 1x1 透明 png
		const pngB64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		const dir = await makePlugin(`
import iconUrl from "./assets/icon.png";
export function Card() { return <img src={iconUrl} alt="" />; }
`);
		await mkdir(join(dir, "src/assets"), { recursive: true });
		await writeFile(join(dir, "src/assets/icon.png"), Buffer.from(pngB64, "base64"));
		const res = await buildPlugin(dir, "src/index.tsx");
		expect(res).toEqual({ ok: true });
		const out = await readFile(join(dir, "dist/index.js"), "utf-8");
		expect(out).toContain("data:image/png;base64,");
		expect(out).toContain(pngB64);
	});

	it("自定义 outDir：产物落到指定目录（内置插件 resources 只读 → userData 缓存路径）", async () => {
		const dir = await makePlugin(`
export function Card() { return <div className="x">hi</div>; }
`);
		const outDir = join(dir, "cache-dist");
		const res = await buildPlugin(dir, "src/index.tsx", { outDir });
		expect(res).toEqual({ ok: true });
		await expect(readFile(join(outDir, "index.js"), "utf-8")).resolves.toContain("window.PerchoUI");
		// 默认路径不出产物
		await expect(readFile(join(dir, "dist/index.js"), "utf-8")).rejects.toThrow();
	});

	it("语法错误返回首条错误 text+location 单行字符串，不产出 dist", async () => {
		const dir = await makePlugin(`
export function Card() { return <div>未闭合
`);
		const res = await buildPlugin(dir, "src/index.tsx");
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toContain("src/index.tsx");
			expect(res.error).not.toContain("\n");
		}
		// 构建失败不应留下 dist 产物
		await expect(readFile(join(dir, "dist/index.js"), "utf-8")).rejects.toThrow();
	});
});
