import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import {
	codemodeSessionOptions,
	readCodemodeConfig,
	readCodemodeEnabled,
	writeCodemodeEnabled,
	writeCodemodeOnly,
} from "../src/settings/codemode";

const roots: string[] = [];
function isolatedDir() {
	const base = resolve("../../.local/tmp/codemode-tests");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "run-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("独占模式默认关闭，和总开关独立保存；并发写入不互相覆盖", async () => {
	const dir = isolatedDir();
	expect(readCodemodeConfig(dir)).toEqual({ enabled: true, only: false });
	await Promise.all([writeCodemodeOnly(dir, true), writeCodemodeEnabled(dir, false)]);
	expect(readCodemodeConfig(dir)).toEqual({ enabled: false, only: true });
	await writeCodemodeEnabled(dir, true);
	expect(readCodemodeConfig(dir)).toEqual({ enabled: true, only: true });
	await writeCodemodeOnly(dir, false);
	expect(readCodemodeConfig(dir)).toEqual({ enabled: true, only: false });
});

it("缺省开启，保存关闭与重新开启；不覆盖其他字段", async () => {
	const dir = isolatedDir();
	expect(readCodemodeEnabled(dir)).toBe(true);
	writeFileSync(join(dir, "codemode.json"), JSON.stringify({ extra: 1 }));
	await writeCodemodeEnabled(dir, false);
	expect(readCodemodeEnabled(dir)).toBe(false);
	expect(JSON.parse(readFileSync(join(dir, "codemode.json"), "utf8"))).toEqual({
		extra: 1,
		enabled: false,
	});
	await writeCodemodeEnabled(dir, true);
	expect(readCodemodeEnabled(dir)).toBe(true);
});

it.each(["{", "null", "[]"])("损坏配置拒绝保存：%s", async (raw) => {
	const dir = isolatedDir();
	writeFileSync(join(dir, "codemode.json"), raw);
	await expect(writeCodemodeEnabled(dir, false)).rejects.toThrow("配置文件损坏");
});

it.each([undefined, ["read", "tool_search"], ["+grep", "-write"]])(
	"默认激活 Code Mode，保留其他工具选择：%j",
	async (defaultTools) => {
		const dir = isolatedDir();
		const settings = SettingsManager.inMemory({ defaultTools });
		const before = settings.getDefaultTools() ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
		codemodeSessionOptions(settings, dir);
		expect(settings.getDefaultTools()).toEqual([...before, "codemode"]);
	},
);

it.each([true, false])("真实 SDK 的激活与排除行为：enabled=%s", async (enabled) => {
	const dir = isolatedDir();
	await writeCodemodeEnabled(dir, enabled);
	const settings = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: settings,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [{ name: "codemode", builtin: true, factory: createCodemodeExtension() }],
	});
	await resourceLoader.reload();
	const options = codemodeSessionOptions(settings, dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		settingsManager: settings,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		...options,
	});
	try {
		expect(session.getActiveToolNames().includes("codemode")).toBe(enabled);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
		if (!enabled) {
			// MCP 的自动激活也经这个公开入口，关闭后不能重新加入。
			session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
			expect(session.getActiveToolNames()).not.toContain("codemode");
		}
	} finally {
		session.dispose();
	}
});
