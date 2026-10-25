import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { cleanProjectExtraDirs } from "@percho/shared";

/**
 * 项目的额外目录（spec：只做上下文声明，不进资源发现、不改 cwd、不做沙箱）。
 *
 * 以**内置扩展**的形式注入系统提示词（和 permission-gate / todo-reminder 一样由 Percho 代码内联注册），
 * 段落写进 `systemPromptOptions.sections`：pi 会据此渲染并只把「变化的段落」作为 transcript delta 追加，
 * 不会顶掉 SDK 自己发现的段落（APPEND_SYSTEM / 项目上下文 / skills / cwd 都还在）。
 *
 * 为什么不是 `appendSystemPrompt`：那个入口会替换文件发现的结果；扩展的 section 是叠加语义。
 * 每次 `before_agent_start` 现取一次目录：配置改了下一轮就生效（不做运行中的主动推送）。
 * 段落只写不清：pi 每轮都从基础选项浅拷贝 `sections`，所以列表清空后下一轮自然没有这一段；
 * 反过来「清空」会误删别的扩展/配置写进同名 section 的内容。
 */

/** 段落名（会渲染成 `<project_extra_dirs>…</project_extra_dirs>`，也是 transcript 里的 section 名） */
export const PROJECT_EXTRA_DIRS_SECTION = "project_extra_dirs";

/**
 * 提示段落（**措辞就是行为契约，改它等于改模型行为**）：空列表 → undefined（不注入）。
 */
export function extraDirsPrompt(dirs: string[]): string | undefined {
	if (dirs.length === 0) return undefined;
	return ["项目还有这些目录（不在 cwd 内，需要时用绝对路径访问）：", ...dirs.map((dir) => `- ${dir}`)].join(
		"\n",
	);
}

export function makeProjectExtraDirsExtension(opts: {
	/** 会话 cwd：清洗规则用它剔除「等于 cwd」的条目 */
	cwd: string;
	/** 现取该项目配置的额外目录（脏值在扩展内再洗一遍，库调用方不必先归一化） */
	getDirs: () => string[];
}): InlineExtension {
	return {
		name: "project-extra-dirs",
		factory: (pi) => {
			pi.on("before_agent_start", (event) => {
				const text = extraDirsPrompt(cleanProjectExtraDirs(opts.cwd, opts.getDirs()));
				if (text) event.systemPromptOptions.sections[PROJECT_EXTRA_DIRS_SECTION] = text;
			});
		},
	};
}
