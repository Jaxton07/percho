/**
 * channel-watch — 跨会话文件协作内置扩展（spec：.local/docs/design/spec/channel-automation.md）。
 *
 * 目录协议 `.local/agent-work/{channel,spec,plan}` 自动初始化 + gitignore；
 * 订阅频道后 fs.watch 感知另一会话的文件更新，sendUserMessage 唤醒本会话按协议查收；
 * 防环四层（自写抑制/hash 去重/防抖/乒乓上限暂停）。总开关 channelWatchEnabled
 * 用户级 settings.json（默认开），关 = 零副作用。
 */

export {
	clearChannelWatchEnabledCache,
	readChannelWatchEnabled,
	writeChannelWatchEnabled,
} from "./config";
export type { ChannelWatchOptions } from "./extension";
export { buildWakeMessage, makeChannelWatchExtension } from "./extension";
export { contentHash, LoopGuard } from "./guard";
export {
	AGENT_WORK_REL,
	agentWorkRoot,
	channelRoot,
	ensureAgentWorkInit,
	planRoot,
	specRoot,
	topicDir,
	validateTopic,
} from "./init";
export { buildSubsPayload, restoreSubscriptions, SUBSCRIPTION_CUSTOM_TYPE } from "./subscriptions";
export { makeChannelTools } from "./tools";
export { ChannelWatcher, parseWatchFilename } from "./watcher";
