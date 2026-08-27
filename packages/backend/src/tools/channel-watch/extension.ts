import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../log";
import { readChannelWatchEnabled } from "./config";
import { contentHash, LoopGuard } from "./guard";
import { channelRoot, ensureAgentWorkInit, validateTopic } from "./init";
import { appendPost, MESSAGES_FILE } from "./post";
import { buildSubsPayload, restoreSubscriptions, SUBSCRIPTION_CUSTOM_TYPE } from "./subscriptions";
import { makeChannelTools } from "./tools";
import { type ChannelWatchEvent, ChannelWatcher } from "./watcher";

const log = createLogger("channel-watch");

/**
 * channel-watch 内置扩展（spec channel-automation.md + channel-post.md）：
 * 跨会话文件协作——订阅频道 → 另一会话 channel_post 写 MESSAGES.md → fs.watch 感知 →
 * sendUserMessage 唤醒本会话按协议查收（仅 MESSAGES.md 触发唤醒，其余频道文件静默）。
 *
 * 接线一览（钩子全 try/catch 绝不 throw）：
 * - session_start：开关 → trusted 门 → 目录协议 init（首次 notify）→ 恢复订阅（appendEntry）
 *   → 非空订阅惰性起 watcher → 注册三工具（幂等）
 * - input：真人/rpc 消息介入 → 清乒乓计数（source!=="extension"）
 * - tool_call：write/edit 目标 → guard.markSelfWrite（自写抑制）
 * - watcher onEvent：订阅过滤 → 仅 MESSAGES.md → 读文件 hash → guard.shouldDeliver（自写/hash/暂停）
 *   → sendUserMessage({deliverAs:"followUp"})（流式中排队、空闲立即——SDK prompt 语义）
 *   → recordDelivered（hash 快照 + 乒乓计数，上限触发暂停 + notify）
 * - session_shutdown：watcher.stop + guard.reset（幂等）
 */

/** 唤醒消息模板（spec channel-post D3，一行固定文案，不携带消息内容） */
export function buildWakeMessage(topic: string, at: Date = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `[channel:${topic}] 有新消息（${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}），请读 .local/agent-work/channel/${topic}/MESSAGES.md 查收。`;
}

export interface ChannelWatchOptions {
	agentDir: string;
	/** 项目根（会话 cwd） */
	cwd: string;
	/** 开关读取（缺省 readChannelWatchEnabled(agentDir)，测试注入） */
	isEnabled?: () => boolean;
	/** guard 时间函数（测试注入） */
	now?: () => number;
	/** 唤醒发送（测试注入；缺省 pi.sendUserMessage） */
	sendWake?: (text: string) => void;
	/** notify（测试注入；缺省 lastCtx.ui.notify） */
	notify?: (text: string) => void;
}

export function makeChannelWatchExtension(options: ChannelWatchOptions): InlineExtension {
	return {
		name: "channel-watch",
		factory: (pi) => {
			const enabled = options.isEnabled ?? (() => readChannelWatchEnabled(options.agentDir));
			const guard = new LoopGuard({ now: options.now });
			const sendWake =
				options.sendWake ?? ((text: string) => pi.sendUserMessage(text, { deliverAs: "followUp" }));

			// --- 会话闭包状态 ---
			let active = false;
			let trusted = false;
			let watcher: ChannelWatcher | null = null;
			let lastCtx: ExtensionContext | null = null;
			let toolsBound = false;
			const subscriptions = new Set<string>();

			const notify = (text: string): void => {
				try {
					if (options.notify) {
						options.notify(text);
						return;
					}
					lastCtx?.ui.notify(text, "warning");
				} catch (err) {
					log.warn("channel-watch notify 失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			};

			// 多会话并发时行归属（决策 5）：短 8 位 id 足以 grep 反查；session_start 前拿到
			// 不到时留空（watcher 惰性起在 session_start 之后，实际不会缺）
			const shortId = (): string | undefined => {
				try {
					return lastCtx?.sessionManager.getSessionId().slice(0, 8);
				} catch {
					return undefined;
				}
			};

			const persist = (): void => {
				try {
					pi.appendEntry(SUBSCRIPTION_CUSTOM_TYPE, buildSubsPayload(subscriptions));
				} catch (err) {
					log.warn("订阅 appendEntry 失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			};

			const onWatchEvent = (event: ChannelWatchEvent): void => {
				try {
					if (!active || !subscriptions.has(event.topic)) return;
					// 触发收窄（spec channel-post）：仅 MESSAGES.md 投递唤醒，其余频道文件静默
					if (basename(event.relPath) !== MESSAGES_FILE) return;
					const abs = join(channelRoot(options.cwd), event.relPath);
					void (async () => {
						let hash: string;
						try {
							hash = contentHash(await readFile(abs, "utf8"));
						} catch {
							return; // 文件已删/不可读：无内容可比，跳过（删除场景无「查收」语义）
						}
						const decision = guard.shouldDeliver(event.topic, event.relPath, hash, abs);
						if (!decision.deliver) {
							log.info("唤醒抑制", {
								sessionId: shortId(),
								topic: event.topic,
								relPath: event.relPath,
								reason: decision.reason,
							});
							return;
						}
						sendWake(buildWakeMessage(event.topic));
						log.info("channel 唤醒已投递", {
							sessionId: shortId(),
							topic: event.topic,
							relPath: event.relPath,
						});
						const pausedNow = guard.recordDelivered(event.topic, event.relPath, hash);
						if (pausedNow) {
							notify(
								`channel-watch：频道 [${event.topic}] 10 分钟内互触发达到上限，已暂停该频道的自动唤醒（防 token 环烧）。如需恢复，让模型重新执行 channel_subscribe(${event.topic})。`,
							);
						}
					})();
				} catch (err) {
					log.warn("channel-watch 事件处理失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			};

			const ensureWatcher = async (): Promise<void> => {
				if (watcher) return;
				const w = new ChannelWatcher({
					channelRoot: channelRoot(options.cwd),
					onEvent: onWatchEvent,
				});
				const mode = await w.start(); // fs.watch 失败自动降级轮询，无 failed 分支
				watcher = w;
				log.info("channel watcher 启动", { mode, root: channelRoot(options.cwd) });
			};

			const stopWatcher = (): void => {
				if (watcher) {
					watcher.stop();
					watcher = null;
				}
			};

			const bindTools = (): void => {
				if (toolsBound) return;
				toolsBound = true;
				for (const tool of makeChannelTools({
					cwd: options.cwd,
					getSubscriptions: () => new Set(subscriptions),
					subscribe(topic) {
						const invalid = validateTopic(topic);
						if (invalid) return { ok: false, error: invalid };
						if (!trusted) {
							return {
								ok: false,
								error: "项目未受信任（trusted），频道协作不可用；请在设置中信任本项目后重开会话",
							};
						}
						const resumed = guard.isPaused(topic);
						guard.resumeTopic(topic);
						subscriptions.add(topic);
						persist();
						void ensureWatcher();
						return { ok: true, resumed };
					},
					async post(topic, message, closed) {
						if (!trusted) {
							return {
								ok: false,
								error: "项目未受信任（trusted），频道协作不可用；请在设置中信任本项目后重开会话",
							};
						}
						try {
							const sessionId = lastCtx?.sessionManager.getSessionId();
							const file = await appendPost(options.cwd, { topic, message, closed, sessionId });
							// appendFile 不经 write/edit tool_call 钩子，手动标记自写
							// （否则「自订阅频道自 post」会自我唤醒）
							guard.markSelfWrite(file);
							return { ok: true };
						} catch (err) {
							return { ok: false, error: err instanceof Error ? err.message : String(err) };
						}
					},
					unsubscribe(topic) {
						if (!subscriptions.delete(topic)) return { ok: false, error: `未订阅频道 [${topic}]` };
						guard.forgetTopic(topic);
						persist();
						if (subscriptions.size === 0) stopWatcher();
						return { ok: true };
					},
					pausedTopics: () => guard.pausedTopicList(),
				})) {
					pi.registerTool(tool);
				}
			};

			// --- 生命周期 ---
			pi.on("session_start", async (_event, ctx) => {
				try {
					if (!enabled()) {
						active = false;
						return;
					}
					active = true;
					lastCtx = ctx;
					trusted = ctx.isProjectTrusted() === true;
					if (trusted) {
						const init = await ensureAgentWorkInit(options.cwd);
						if (init.created.length > 0) {
							notify(
								`channel-watch：已初始化协作目录 .local/agent-work/{channel,spec,plan}（gitignore 已处理：${init.gitignore}）。`,
							);
						}
					}
					// 恢复订阅（resume/restart）；appendEntry 只在文件存在时有意义（冒烟 V3：
					// 首条 assistant 前不落盘——但订阅必发生在对话后，resume 场景文件必存在）
					try {
						const restored = restoreSubscriptions(ctx.sessionManager.getEntries());
						for (const topic of restored) subscriptions.add(topic);
					} catch (err) {
						log.warn("订阅恢复失败（按空订阅处理）", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
					if (trusted && subscriptions.size > 0) {
						await ensureWatcher();
					}
					bindTools();
					log.info("channel-watch session_start", {
						trusted,
						subscriptions: subscriptions.size,
						watcher: watcher?.mode ?? "idle",
					});
				} catch (err) {
					// init/恢复失败 → 降级为不激活（会话照常）
					active = false;
					log.error("channel-watch session_start 失败，降级关闭", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});

			// 真人/rpc 输入介入 → 清乒乓计数（环烧需「无真实用户介入」才成立）
			pi.on("input", (event) => {
				try {
					if (event.source === "extension") return;
					guard.noteUserMessage();
					return undefined;
				} catch {
					return undefined;
				}
			});

			// 自写抑制：write/edit 目标路径（bash 写入不可靠，由 hash 去重 + 防抖兜底）
			pi.on("tool_call", (event) => {
				try {
					if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
					const input = event.input as { path?: unknown; file?: unknown };
					const raw = typeof input?.path === "string" ? input.path : input?.file;
					if (typeof raw !== "string" || raw.length === 0) return undefined;
					const abs = isAbsolute(raw) ? raw : resolve(options.cwd, raw);
					guard.markSelfWrite(abs);
					return undefined;
				} catch {
					return undefined;
				}
			});

			pi.on("session_shutdown", () => {
				try {
					stopWatcher();
					guard.reset();
					active = false;
				} catch (err) {
					log.warn("channel-watch shutdown 清理失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
		},
	};
}
