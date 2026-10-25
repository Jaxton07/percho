import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extraDirsPrompt, ProjectResourceLoader } from "../src/project/trust-loader";

/**
 * 项目额外目录的提示段落（spec：只是上下文声明，不进资源发现、不改 cwd）。
 * 纯函数 + 资源加载器接线两层：段落顺序（静态 → 额外目录 → SDK 发现）只能靠接线断言兜住。
 */
describe("extraDirsPrompt（措辞是行为契约）", () => {
	it("空数组不注入（undefined，而不是空串）", () => {
		expect(extraDirsPrompt([])).toBeUndefined();
	});

	it("单目录：一句说明 + 一行绝对路径", () => {
		expect(extraDirsPrompt(["/abs/one"])).toBe(
			"项目还有这些目录（不在 cwd 内，需要时用绝对路径访问）：\n- /abs/one",
		);
	});

	it("多目录：保序，且每个目录单独一行", () => {
		const text = extraDirsPrompt(["/abs/a", "/abs/b/c"]) ?? "";
		expect(text.split("\n")).toEqual([
			"项目还有这些目录（不在 cwd 内，需要时用绝对路径访问）：",
			"- /abs/a",
			"- /abs/b/c",
		]);
	});
});

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
	const sandbox = resolve("../../.local/tmp/project-extra-dirs-tests");
	await mkdir(sandbox, { recursive: true });
	root = await mkdtemp(join(sandbox, "case-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

const STATIC = "DESKTOP_STATIC_MARKER";

async function loadWith(projectExtraDirs: ((cwd: string) => string[]) | undefined) {
	const trustStore = new ProjectTrustStore(agentDir);
	const loader = new ProjectResourceLoader({
		trustStore,
		ask: async () => undefined,
		canAsk: () => false,
		buildExtensions: () => [],
		// projectTrust=false = 无人值守路径：不做信任弹窗，直接加载（与桌面端实际接线无关，只为跑通构造）
		projectTrust: false,
		desktopIntegration: { appendSystemPrompt: [STATIC], additionalSkillPaths: [] },
		projectExtraDirs,
	});
	const { resourceLoader } = await loader.load(cwd);
	// appendSystemPrompt 在 TS 里是 private，运行时可读（阶段 0 冒烟已确认）；这里只断言段落顺序
	return (resourceLoader as unknown as { appendSystemPrompt: string[] }).appendSystemPrompt;
}

describe("ProjectResourceLoader 接线", () => {
	it("额外目录段落插在静态段落之后", async () => {
		const paragraphs = await loadWith(() => ["/abs/extra"]);
		expect(paragraphs[0]).toBe(STATIC);
		expect(paragraphs[1]).toBe(extraDirsPrompt(["/abs/extra"]));
		expect(paragraphs).toHaveLength(2);
	});

	it("按 cwd 取目录：回调收到会话 cwd，空列表不产生段落", async () => {
		const seen: string[] = [];
		const paragraphs = await loadWith((dir) => {
			seen.push(dir);
			return [];
		});
		expect(seen).toEqual([cwd]);
		expect(paragraphs).toEqual([STATIC]);
	});

	it("未配置回调时不注入（纯 CLI 默认行为不变）", async () => {
		const paragraphs = await loadWith(undefined);
		expect(paragraphs).toEqual([STATIC]);
	});
});
