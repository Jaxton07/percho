import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../log";

const log = createLogger("channel-watch-init");

const execFileAsync = promisify(execFile);

/**
 * 目录协议初始化（spec D6）：`.local/agent-work/{channel,spec,plan}` 三子目录 +
 * gitignore 精确追加。纯 fs/git 操作，可单测；调用方（extension.ts）负责
 * trusted 门 + try/catch（钩子绝不 throw）。
 *
 * - 幂等：目录已存在跳过；gitignore 已忽略（check-ignore 退出码 0）不重复写
 * - 非 git 仓库（退出码 128）：跳过 gitignore 步骤
 * - 只追加精确路径 `.local/agent-work/`，绝不整个忽略 `.local/`
 */

export const AGENT_WORK_REL = ".local/agent-work";
export const GITIGNORE_LINE = `${AGENT_WORK_REL}/`;

export function agentWorkRoot(cwd: string): string {
	return join(cwd, AGENT_WORK_REL);
}
export function channelRoot(cwd: string): string {
	return join(agentWorkRoot(cwd), "channel");
}
export function specRoot(cwd: string): string {
	return join(agentWorkRoot(cwd), "spec");
}
export function planRoot(cwd: string): string {
	return join(agentWorkRoot(cwd), "plan");
}
export function topicDir(cwd: string, topic: string): string {
	return join(channelRoot(cwd), topic);
}

/**
 * topic 合法性校验（spec 安全清单）：频道目录名，限 `[A-Za-z0-9._-]+`，
 * 禁 `..`/绝对路径/路径分隔符/前导点（隐藏目录）。
 * 返回 null = 合法；否则返回错误消息。
 */
export function validateTopic(topic: string): string | null {
	if (typeof topic !== "string" || topic.length === 0) return "topic 不能为空";
	if (topic.length > 128) return "topic 过长（≤128 字符）";
	if (topic === "." || topic === "..") return "topic 不能是 . 或 ..";
	if (topic.startsWith(".")) return "topic 不能以 . 开头（隐藏目录）";
	if (topic.includes("/") || topic.includes("\\")) return "topic 不能包含路径分隔符";
	if (topic.includes("\0")) return "topic 含非法字符";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(topic)) {
		return "topic 只能包含字母数字 . _ -（且以字母数字开头）";
	}
	return null;
}

export type GitignoreOutcome = "ignored" | "appended" | "not-git" | "skipped";

export interface InitResult {
	/** 本次新建的目录（绝对路径，已存在的不列） */
	created: string[];
	/** gitignore 步骤结果 */
	gitignore: GitignoreOutcome;
	/** init 之前目录协议已完整存在（用于决定是否 notify「首次初始化」） */
	alreadyInitialized: boolean;
}

/** git check-ignore 退出码语义：0=已忽略 1=未忽略 128+=非 git 仓库/出错 */
async function checkIgnored(cwd: string): Promise<"ignored" | "not-ignored" | "not-git"> {
	try {
		const { stdout } = await execFileAsync("git", ["check-ignore", "-q", AGENT_WORK_REL], {
			cwd,
			timeout: 5000,
		});
		void stdout;
		return "ignored";
	} catch (err) {
		const code = (err as { code?: number | string }).code;
		if (code === 1) return "not-ignored";
		if (typeof code === "number" && code >= 128) return "not-git";
		// ENOENT（git 不存在）等 → 非致命，跳过
		return "not-git";
	}
}

/** mkdir -p，已存在返回 false */
async function ensureDir(dir: string): Promise<boolean> {
	try {
		await stat(dir);
		return false;
	} catch {
		await mkdir(dir, { recursive: true });
		return true;
	}
}

/**
 * 确保目录协议 + gitignore。cwd 必须是项目根（会话 cwd）。
 * gitignore 追加目标：`<cwd>/.gitignore`（不存在则创建）。
 */
export async function ensureAgentWorkInit(cwd: string): Promise<InitResult> {
	const dirs = [agentWorkRoot(cwd), channelRoot(cwd), specRoot(cwd), planRoot(cwd)];
	let alreadyInitialized = true;
	const created: string[] = [];
	for (const dir of dirs) {
		const isNew = await ensureDir(dir);
		if (isNew) {
			created.push(dir);
			alreadyInitialized = false;
		}
	}

	let gitignore: GitignoreOutcome = "skipped";
	const ignoreState = await checkIgnored(cwd);
	if (ignoreState === "ignored") {
		gitignore = "ignored";
	} else if (ignoreState === "not-ignored") {
		const gitignorePath = join(cwd, ".gitignore");
		let existing = "";
		try {
			existing = await readFile(gitignorePath, "utf8");
		} catch {
			existing = "";
		}
		// 已有精确行（或无斜杠变体）→ 视为已忽略，不重复追加
		const lines = existing.split(/\r?\n/);
		if (lines.some((l) => l.trim() === GITIGNORE_LINE || l.trim() === AGENT_WORK_REL)) {
			gitignore = "ignored";
		} else {
			const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
			await appendFile(gitignorePath, `${prefix}${GITIGNORE_LINE}\n`);
			gitignore = "appended";
		}
	} else {
		gitignore = "not-git";
	}

	log.debug("agent-work init", { created: created.length, gitignore });
	return { created, gitignore, alreadyInitialized };
}
