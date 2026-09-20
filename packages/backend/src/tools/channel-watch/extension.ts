import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../log";
import { readChannelWatchEnabled } from "./config";
import { contentHash, LoopGuard } from "./guard";
import { channelRoot, ensureAgentWorkInit, topicDir, validateTopic } from "./init";
import { appendPost, MESSAGES_FILE } from "./post";
import { buildSubsPayload, restoreSubscriptionState, SUBSCRIPTION_CUSTOM_TYPE } from "./subscriptions";
import { makeChannelTools } from "./tools";
import { type ChannelWatchEvent, ChannelWatcher, type ChannelWatcherOptions } from "./watcher";

const log = createLogger("channel-watch");

/**
 * channel-watch 内置扩展（spec channel-automation.md + channel-post.md）：
 * 跨会话文件协作——订阅频道 → 另一会话 channel_post 写 MESSAGES.md → fs.watch 感知 →
 * sendUserMessage 唤醒本会话按协议查收（仅 MESSAGES.md 触发唤醒，其余频道文件静默）。
 *
 * 接线一览（钩子全 try/catch 绝不 throw）：
 * - session_start：开关 → trusted 门 → 目录协议 init（首次 notify）→ 恢复订阅+游标（appendEntry）
 *   → 非空订阅惰性起 watcher（single-flight）→ 上报有效订阅快照（enabled+trusted 才计入）
 *   → 逐 topic 对账补投（离线期间的新消息）
 * - input：真人/rpc 消息介入 → 清乒乓计数（source!=="extension"）
 * - tool_call：write/edit 目标 → guard.markSelfWrite（自写抑制）
 * - watcher onEvent：订阅过滤 → 仅 MESSAGES.md → 读文件 hash → cursor 去重 → guard.shouldDeliver
 *   （自写/hash/暂停）→ 投递（投递必推进 cursor；自写抑制也推进；paused 不推进）
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
	/**
	 * 有效运行态订阅快照变化回调（spec §6.1；PiBackend 记录用）。
	 * 触发点：session_start 恢复完成后（含空集）、subscribe、unsubscribe、session_shutdown。
	 * 阶段 0 只固定注入点，调用点见 plan 阶段 1.1。
	 */
	onSubscriptionsChanged?: (sessionId: string, topics: ReadonlySet<string>) => void;
	/** watcher 工厂（缺省 new ChannelWatcher；测试注入短防抖，生产默认 3s/5s 不变） */
	watcherFactory?: (options: ChannelWatcherOptions) => ChannelWatcher;
	/** 读内容 hash（缺省读文件，不存在 → null；测试注入可复现「基线读取 ↔ watcher 就绪」竞态） */
	readFileHash?: (absPath: string) => Promise<string | null>;
}

/** 读文件内容 hash（文件不存在/不可读 → null）。阶段 0 只是把注入点接上，语义与改动前一致 */
async function defaultReadFileHash(absPath: string): Promise<string | null> {
	try {
		return contentHash(await readFile(absPath, "utf8"));
	} catch {
		return null;
	}
}

export function makeChannelWatchExtension(options: ChannelWatchOptions): InlineExtension {
	return {
		name: "channel-watch",
		factory: (pi) => {
			const enabled = options.isEnabled ?? (() => readChannelWatchEnabled(options.agentDir));
			const guard = new LoopGuard({ now: options.now });
			const sendWake =
				options.sendWake ?? ((text: string) => pi.sendUserMessage(text, { deliverAs: "followUp" }));
			const readHash = options.readFileHash ?? defaultReadFileHash;
			const makeWatcher =
				options.watcherFactory ?? ((opts: ChannelWatcherOptions) => new ChannelWatcher(opts));

			// --- 会话闭包状态 ---
			let active = false;
			let trusted = false;
			let watcher: ChannelWatcher | null = null;
			let lastCtx: ExtensionContext | null = null;
			let toolsBound = false;
			const subscriptions = new Set<string>();
			/**
			 * topic → 最后已确认的 `MESSAGES.md` 内容 hash | null（null = 确认当时文件不存在）。
			 * 与订阅集同一份持久快照：每次推进都 append 全量（spec §6.3/§6.5）。key 缺失 = 未知基线。
			 */
			const cursors = new Map<string, string | null>();
			/** watcher 世代：stop/shutdown 时 +1，用于作废「启动中」的那一轮（不挂孤儿 watcher） */
			let watcherEpoch = 0;
			let watcherPromise: Promise<void> | null = null;

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

			/** 完整 sessionId（上报 backend 订阅快照的 key，必须与 registry 一致；取不到不算错） */
			const fullSessionId = (): string | undefined => {
				try {
					return lastCtx?.sessionManager.getSessionId();
				} catch {
					return undefined;
				}
			};

			/**
			 * 上报「有效运行态订阅」快照（spec §6.1）：只有 enabled + trusted 才计入——
			 * 未启用/未受信任的会话根本收不到唤醒，不该因此被永久排除在内存回收之外。
			 * 只传副本（调用方不能反向改到本闭包的订阅集）；回调抛错只记日志，绝不打断订阅/发消息/生命周期。
			 */
			const reportSubscriptions = (): void => {
				const onChanged = options.onSubscriptionsChanged;
				if (!onChanged) return;
				try {
					const sessionId = fullSessionId();
					if (!sessionId) {
						log.warn("订阅快照未上报：拿不到 sessionId");
						return;
					}
					onChanged(sessionId, new Set(active && trusted ? subscriptions : []));
				} catch (err) {
					log.warn("订阅快照上报失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			};

			const persist = (): void => {
				try {
					// 全量快照 = topics + cursors（两者必须一起写：分开写会出现「新订阅配旧游标」的中间态）
					pi.appendEntry(SUBSCRIPTION_CUSTOM_TYPE, buildSubsPayload(subscriptions, cursors));
				} catch (err) {
					log.warn("订阅 appendEntry 失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			};

			/** 订阅频道主文件绝对路径（topic 已在 subscribe/restore 侧过 validateTopic） */
			const messagesPath = (topic: string): string => join(topicDir(options.cwd, topic), MESSAGES_FILE);

			/** 当前版本（文件不存在/不可读 → null） */
			const currentHash = (topic: string): Promise<string | null> => readHash(messagesPath(topic));

			/**
			 * 推进 cursor 并落盘（at-least-once：落盘失败只告警，内存保留——重启后允许重复提醒，
			 * 不允许静默漏提醒）。值未变不写 JSONL。
			 */
			const advanceCursor = (topic: string, hash: string | null): void => {
				if (cursors.has(topic) && cursors.get(topic) === hash) return;
				cursors.set(topic, hash);
				persist();
			};

			/**
			 * 投递一次唤醒（live 与恢复补投共用的唯一入口）：sendWake → guard 记账（乒乓保护不变）
			 * → 推进 cursor。`sendUserMessage` 是同步 void，无 throw 视为已受理（spec §6.5）。
			 */
			const deliverWake = (topic: string, relPath: string, hash: string): void => {
				sendWake(buildWakeMessage(topic));
				log.info("channel 唤醒已投递", { sessionId: shortId(), topic, relPath });
				const pausedNow = guard.recordDelivered(topic, relPath, hash);
				advanceCursor(topic, hash);
				if (pausedNow) {
					notify(
						`channel-watch：频道 [${topic}] 10 分钟内互触发达到上限，已暂停该频道的自动唤醒（防 token 环烧）。如需恢复，让模型重新执行 channel_subscribe(${topic})。`,
					);
				}
			};

			/**
			 * 单 topic 版本对账（session_start 恢复后 / 首次订阅 watcher 就绪后）：
			 * - 已知 cursor 与当前版本不同 → 补投一次（离线期间的写入）；
			 * - cursor key 缺失（旧载荷）→ 只记基线，不补历史；
			 * - 文件不存在 → 不唤醒，cursor 记为 null；
			 * - 期间 live 已投递（cursor 变了）→ 直接让位，避免重复与 cursor 回退。
			 */
			const reconcileTopic = async (topic: string): Promise<void> => {
				try {
					const before = cursors.get(topic);
					const hash = await currentHash(topic);
					if (cursors.get(topic) !== before) return;
					if (before === hash) return;
					if (hash === null) {
						advanceCursor(topic, null);
						return;
					}
					if (before === undefined) {
						advanceCursor(topic, hash);
						return;
					}
					deliverWake(topic, `${topic}/${MESSAGES_FILE}`, hash);
				} catch (err) {
					log.warn("channel-watch 补投对账失败", {
						topic,
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
						// fire-and-forget 分支内部必须完整 catch（不得漏出 unhandled rejection）
						try {
							const hash = await readHash(abs);
							if (hash === null) {
								// 文件被删/不可读：不唤醒；已知 cursor 则推进为 null（未来重建能识别为变化）
								if (cursors.has(event.topic) && cursors.get(event.topic) !== null) {
									advanceCursor(event.topic, null);
								}
								return;
							}
							// live 先比 cursor（跨重启的持久去重）：同 hash 直接抑制
							if (cursors.get(event.topic) === hash) {
								log.info("唤醒抑制", {
									sessionId: shortId(),
									topic: event.topic,
									reason: "cursor-unchanged",
								});
								return;
							}
							const decision = guard.shouldDeliver(event.topic, event.relPath, hash, abs);
							if (!decision.deliver) {
								log.info("唤醒抑制", {
									sessionId: shortId(),
									topic: event.topic,
									reason: decision.reason,
								});
								// 自写抑制：那是本会话自己的写入，无需唤醒；但 cursor 必须推进——
								// 否则 shutdown 发生在 watcher 防抖前时，重开会把自己的写入当离线新消息补投（§6.5）
								if (decision.reason === "self-write" || decision.reason === "hash-unchanged") {
									advanceCursor(event.topic, hash);
								}
								// paused：不推进（显式重新 subscribe 后可合并补投一次）
								return;
							}
							deliverWake(event.topic, event.relPath, hash);
						} catch (err) {
							log.warn("channel-watch 事件处理失败", {
								error: err instanceof Error ? err.message : String(err),
							});
						}
					})();
				} catch (err) {
					log.warn("channel-watch 事件处理失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			};

			/**
			 * 启动 watcher（**single-flight**，spec §6.6）：并发 subscribe/session_start 只创建一个实例；
			 * 失败不抛（清空 promise，下次订阅可重试）；启动期间 shutdown 已作废本轮 → 停掉自己，不挂孤儿。
			 */
			const ensureWatcher = (): Promise<void> => {
				if (watcher) return Promise.resolve();
				if (watcherPromise) return watcherPromise;
				const epoch = watcherEpoch;
				const w = makeWatcher({
					channelRoot: channelRoot(options.cwd),
					onEvent: onWatchEvent,
				});
				const run = (async () => {
					try {
						const mode = await w.start(); // fs.watch 失败自动降级轮询，无 failed 分支
						if (epoch !== watcherEpoch) {
							w.stop();
							return;
						}
						watcher = w;
						log.info("channel watcher 启动", { mode, root: channelRoot(options.cwd) });
					} catch (err) {
						log.warn("channel watcher 启动失败，下次订阅重试", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				})();
				watcherPromise = run;
				void run.finally(() => {
					// 只清自己这一轮（期间可能已 stop/重建过）
					if (watcherPromise === run) watcherPromise = null;
				});
				return run;
			};

			const stopWatcher = (): void => {
				watcherEpoch += 1; // 作废「启动中」的那一轮（它会在 start 返回后自停）
				watcherPromise = null; // 让下一次 ensureWatcher 能真起新实例
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
					subscribe: async (topic) => {
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
						// 首次订阅：先把当前版本记为基线（已有历史不提醒），再起 watcher，最后二次对账：
						// 「读基线 ↔ watcher 就绪」之间写入的新消息不能丢（spec §6.4）
						if (!cursors.has(topic)) {
							cursors.set(topic, await currentHash(topic));
						}
						persist();
						reportSubscriptions();
						await ensureWatcher();
						// 二次对账：封住启动竞态；也是 paused 恢复后的「合并补投一次」入口（§6.5）
						await reconcileTopic(topic);
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
							// 本会话也订阅了该 topic 时主动推进 cursor（spec §6.5）：防 shutdown 死在 watcher
							// 防抖之前，重开时把自己的写入当离线新消息补投
							if (subscriptions.has(topic)) {
								try {
									advanceCursor(topic, await readHash(file));
								} catch (err) {
									log.warn("post 后推进 cursor 失败（后续 watcher 事件会收敛）", {
										error: err instanceof Error ? err.message : String(err),
									});
								}
							}
							return { ok: true };
						} catch (err) {
							return { ok: false, error: err instanceof Error ? err.message : String(err) };
						}
					},
					unsubscribe(topic) {
						if (!subscriptions.delete(topic)) return { ok: false, error: `未订阅频道 [${topic}]` };
						guard.forgetTopic(topic);
						cursors.delete(topic); // 退订不留幽灵基线（重订时才重读基线）
						persist();
						reportSubscriptions();
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
				// 先取 ctx：disabled/untrusted 分支也要能上报（空集）
				lastCtx = ctx;
				try {
					if (!enabled()) {
						active = false;
						trusted = false;
						reportSubscriptions();
						return;
					}
					active = true;
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
						// 订阅 + 游标一起恢复（last-wins 全量快照；旧载荷只有 topics = 未知基线）
						const restored = restoreSubscriptionState(ctx.sessionManager.getEntries());
						for (const topic of restored.topics) subscriptions.add(topic);
						for (const [topic, hash] of restored.cursors) cursors.set(topic, hash);
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
					// 恢复完成后再上报（含空集）：backend 据此把本会话标为「有频道订阅」
					reportSubscriptions();
					// watcher 就绪后逐 topic 对账（spec §6.4）：已知 cursor 不同 → 每 topic 补投一次；
					// 旧载荷只建基线；会话离线期间的写入在这里被补上
					if (trusted && subscriptions.size > 0) {
						for (const topic of subscriptions) await reconcileTopic(topic);
					}
				} catch (err) {
					// init/恢复失败 → 降级为不激活（会话照常）
					active = false;
					trusted = false;
					log.error("channel-watch session_start 失败，降级关闭", {
						error: err instanceof Error ? err.message : String(err),
					});
					reportSubscriptions();
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
					trusted = false;
					// 上报空集：会话已不驻留，订阅保护随之解除（backend 也有 dispose 兜底）
					reportSubscriptions();
				} catch (err) {
					log.warn("channel-watch shutdown 清理失败", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
		},
	};
}
