import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../../log";

const log = createLogger("channel-watch-watcher");

/**
 * 频道子树 watcher（spec D4）：仅监听 `<cwd>/.local/agent-work/channel/` 子树。
 *
 * - 首选 `fs.watch(root, {recursive: true})`（macOS 原生支持，V4 冒烟实证 10 连写零丢）
 * - 失败降级：5s 轮询 mtime+size 快照对比（Linux/受限环境）；降级总成功，无 failed 终态
 * - 事件解析：filename 第一段 = topic；以 `.` 开头的条目（.DS_Store / 编辑器临时文件）忽略
 * - 3s 防抖：同一文件多次变更合并为一次 onEvent（spec D5 层 3）
 * - hash 计算与投递判定不在此层（guard + extension 投递管道负责）
 */

export interface ChannelWatchEvent {
	/** 频道主题（channel/ 下第一段目录名） */
	topic: string;
	/** 频道子树内相对路径（含 topic 前缀，如 `channel-automation/IMPL-NOTES.md`） */
	relPath: string;
}

export type WatcherMode = "idle" | "watch" | "poll";

export interface ChannelWatcherOptions {
	channelRoot: string;
	onEvent: (event: ChannelWatchEvent) => void;
	/** 防抖窗口（默认 3000ms） */
	debounceMs?: number;
	/** 降级轮询间隔（默认 5000ms） */
	pollIntervalMs?: number;
}

/** filename → {topic, relPath}；不可用（空 / .开头 / 无 topic 段）返回 null */
export function parseWatchFilename(filename: string | Buffer | null): ChannelWatchEvent | null {
	if (!filename) return null;
	const rel = filename.toString();
	if (rel.length === 0) return null;
	const segments = rel.split(/[\\/]/).filter((s) => s.length > 0);
	if (segments.length === 0) return null;
	const topic = segments[0];
	if (!topic || topic.startsWith(".")) return null;
	// 文件名（最后一段）以 . 开头 → .DS_Store / .swp / .tmp 等噪音，忽略
	const last = segments[segments.length - 1] ?? topic;
	if (last.startsWith(".")) return null;
	return { topic, relPath: segments.join("/") };
}

export class ChannelWatcher {
	private readonly root: string;
	private readonly onEvent: (event: ChannelWatchEvent) => void;
	private readonly debounceMs: number;
	private readonly pollIntervalMs: number;
	private fsWatcher: FSWatcher | null = null;
	private pollTimer: NodeJS.Timeout | null = null;
	private pollSnapshot: Map<string, string> | null = null;
	private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
	private _mode: WatcherMode = "idle";

	constructor(options: ChannelWatcherOptions) {
		this.root = options.channelRoot;
		this.onEvent = options.onEvent;
		this.debounceMs = options.debounceMs ?? 3000;
		this.pollIntervalMs = options.pollIntervalMs ?? 5000;
	}

	get mode(): WatcherMode {
		return this._mode;
	}

	/** 启动：优先 recursive fs.watch，同步 throw/异步 error 即降级轮询（降级总成功） */
	async start(): Promise<WatcherMode> {
		if (this._mode !== "idle") return this._mode;
		try {
			// channelRoot 可能尚不存在（init 失败/竞态）：watch 会 throw → 降级轮询里建快照
			this.fsWatcher = watch(this.root, { recursive: true }, (_eventType, filename) => {
				const parsed = parseWatchFilename(filename);
				if (parsed) this.scheduleDebounced(parsed);
			});
			this.fsWatcher.on("error", (err) => {
				log.warn("fs.watch 错误，转降级轮询", { error: err instanceof Error ? err.message : String(err) });
				this.stopFswatch();
				void this.startPolling();
			});
			this._mode = "watch";
			log.info("channel watcher 启动（fs.watch recursive）", { root: this.root });
			return this._mode;
		} catch (err) {
			log.warn("fs.watch 不可用，降级轮询", {
				root: this.root,
				error: err instanceof Error ? err.message : String(err),
			});
			return this.startPolling();
		}
	}

	private stopFswatch(): void {
		if (this.fsWatcher) {
			this.fsWatcher.close();
			this.fsWatcher = null;
		}
	}

	private async startPolling(): Promise<WatcherMode> {
		if (this.pollTimer) return this._mode;
		this.pollSnapshot = await this.scanSnapshot();
		this.pollTimer = setInterval(() => {
			void this.pollTick();
		}, this.pollIntervalMs);
		// unref：不阻止进程退出（会话关闭时即便 stop 漏调也不悬挂进程）
		this.pollTimer.unref?.();
		this._mode = "poll";
		log.info("channel watcher 启动（降级轮询）", { root: this.root, interval: this.pollIntervalMs });
		return this._mode;
	}

	/** 扫描 channelRoot 两层（topic 目录 → 文件），返回 mtimeMs:size 快照 */
	private async scanSnapshot(): Promise<Map<string, string>> {
		const snapshot = new Map<string, string>();
		try {
			const topics = await readdir(this.root, { withFileTypes: true });
			for (const topicEntry of topics) {
				if (!topicEntry.isDirectory() || topicEntry.name.startsWith(".")) continue;
				const files = await readdir(join(this.root, topicEntry.name), { withFileTypes: true });
				for (const file of files) {
					if (!file.isFile() || file.name.startsWith(".")) continue;
					const relPath = `${topicEntry.name}/${file.name}`;
					try {
						const st = await stat(join(this.root, relPath));
						snapshot.set(relPath, `${st.mtimeMs}:${st.size}`);
					} catch {
						// 扫描中消失：跳过
					}
				}
			}
		} catch {
			// root 不存在等：返回空快照，下轮再试
		}
		return snapshot;
	}

	private async pollTick(): Promise<void> {
		const prev = this.pollSnapshot;
		if (!prev) return;
		const next = await this.scanSnapshot();
		this.pollSnapshot = next;
		for (const [relPath, sig] of next) {
			if (prev.get(relPath) !== sig) {
				const parsed = parseWatchFilename(relPath);
				if (parsed) this.onEvent(parsed);
			}
		}
	}

	private scheduleDebounced(event: ChannelWatchEvent): void {
		const existing = this.debounceTimers.get(event.relPath);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.debounceTimers.delete(event.relPath);
			this.onEvent(event);
		}, this.debounceMs);
		timer.unref?.();
		this.debounceTimers.set(event.relPath, timer);
	}

	/** 停止并清理（幂等；session_shutdown 调用） */
	stop(): void {
		this.stopFswatch();
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.pollSnapshot = null;
		for (const t of this.debounceTimers.values()) clearTimeout(t);
		this.debounceTimers.clear();
		this._mode = "idle";
	}
}
