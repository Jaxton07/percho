import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { channelRoot, validateTopic } from "./init";

/**
 * channel-watch 三工具（spec D4）：channel_subscribe / channel_unsubscribe / channel_list。
 * 经扩展 `pi.registerTool` 注册；订阅状态变更的副作用（appendEntry/watcher 激活）由
 * deps 回调进 extension.ts 闭包完成，工具层纯参数校验 + 结果文案（可单测）。
 * 参数 schema 拍平单 object（AGENTS.md：openai-completions 顶层 anyOf 400 纪律）。
 */

export interface SubscribeOutcome {
	ok: boolean;
	/** 失败原因（ok=false 时给模型看） */
	error?: string;
	/** 订阅成功且该频道曾因乒乓暂停被自动恢复 */
	resumed?: boolean;
}

export interface ChannelToolDeps {
	/** 项目根（会话 cwd） */
	cwd: string;
	/** 订阅一个频道（extension 闭包：改订阅集 + appendEntry + 惰性激活 watcher + 恢复暂停） */
	subscribe(topic: string): SubscribeOutcome;
	/** 退订（空集时停 watcher；guard.forgetTopic） */
	unsubscribe(topic: string): { ok: boolean; error?: string };
	/** 本会话当前订阅集（快照） */
	getSubscriptions(): Set<string>;
	/** 已暂停频道（乒乓上限触发） */
	pausedTopics(): Array<{ topic: string; since: number }>;
}

export const subscribeParams = Type.Object({
	topic: Type.String({ description: "频道主题名（.local/agent-work/channel/ 下的目录名）" }),
});

export const unsubscribeParams = Type.Object({
	topic: Type.String({ description: "要退订的频道主题名" }),
});

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

export function makeChannelTools(deps: ChannelToolDeps): ToolDefinition[] {
	const subscribe: ToolDefinition<typeof subscribeParams> = {
		name: "channel_subscribe",
		label: "Subscribe channel",
		description:
			"订阅一个协作频道（.local/agent-work/channel/<topic>）。订阅后另一会话更新频道文件时，本会话会收到一行唤醒提醒。topic 为频道目录名。",
		promptSnippet: "channel_subscribe({ topic }) — 订阅协作频道，接收文件更新唤醒",
		parameters: subscribeParams,
		async execute(_toolCallId, params) {
			const topic = String((params as { topic?: unknown }).topic ?? "").trim();
			const invalid = validateTopic(topic);
			if (invalid) return textResult(`订阅失败：${invalid}`);
			const result = deps.subscribe(topic);
			if (!result.ok) return textResult(`订阅失败：${result.error ?? "未知错误"}`);
			const resumedNote = result.resumed ? "（该频道此前因频繁互触发被暂停，本次订阅已恢复）" : "";
			return textResult(
				[
					`已订阅频道 [${topic}]，目录 ${channelRoot(deps.cwd)}/${topic}`,
					resumedNote,
					"另一会话更新该目录下文件时，你会收到 `[channel:<topic>]` 开头的提醒，按频道 HANDOFF.md 协议查收即可。",
				]
					.filter(Boolean)
					.join("\n"),
			);
		},
	};

	const unsubscribe: ToolDefinition<typeof unsubscribeParams> = {
		name: "channel_unsubscribe",
		label: "Unsubscribe channel",
		description: "退订一个协作频道，不再接收该频道的文件更新唤醒。",
		promptSnippet: "channel_unsubscribe({ topic }) — 退订频道",
		parameters: unsubscribeParams,
		async execute(_toolCallId, params) {
			const topic = String((params as { topic?: unknown }).topic ?? "").trim();
			const result = deps.unsubscribe(topic);
			if (!result.ok) return textResult(`退订失败：${result.error ?? "未知错误"}`);
			return textResult(`已退订频道 [${topic}]。`);
		},
	};

	const list: ToolDefinition<ReturnType<typeof Type.Object>> = {
		name: "channel_list",
		label: "List channels",
		description: "列出本项目全部协作频道与本会话的订阅状态（含因频繁互触发被暂停的频道）。",
		promptSnippet: "channel_list() — 列出频道与订阅状态",
		parameters: Type.Object({}),
		async execute() {
			const subs = deps.getSubscriptions();
			const paused = new Set(deps.pausedTopics().map((p) => p.topic));
			const root = channelRoot(deps.cwd);
			let dirs: string[] = [];
			try {
				const { readdir } = await import("node:fs/promises");
				const entries = await readdir(root, { withFileTypes: true });
				dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
			} catch {
				dirs = [];
			}
			// 订阅了但目录还没建的也列出（等待对端建立）
			for (const s of subs) if (!dirs.includes(s)) dirs.push(s);
			if (dirs.length === 0) {
				return textResult(`频道根 ${root} 下暂无频道目录，本会话也未订阅任何频道。`);
			}
			const lines = dirs.sort().map((d) => {
				const state = subs.has(d) ? "已订阅" : "未订阅";
				const pause = paused.has(d) ? " ⚠️已暂停（互触发上限，重新订阅可恢复）" : "";
				return `- ${d}：${state}${pause}`;
			});
			return textResult([`频道根：${root}`, ...lines].join("\n"));
		},
	};

	return [subscribe, unsubscribe, list];
}
