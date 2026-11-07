import type { TurnChanges, TurnSpeedRow, TurnTiming } from "@percho/shared";
import { useEffect, useReducer, useState } from "react";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../lib/active-cwd";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { BoltIcon, ClockIcon, MoreIcon } from "../icons";
import { FilePathMenu } from "../ui/FilePathMenu";
import { anchorOfElement, type MenuAnchor } from "../ui/place-menu";

/** en 复数单位（与 MetaGroup 的 pluralUnit 同规则） */
const pluralUnit = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** 紧凑时长（codex 同款）：42s / 3m 05s / 1h 02m；数字 tabular-nums 防跳动 */
function formatDuration(ms: number): string {
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total}s`;
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * 轮次计时（codex / claude code 同款）：轮开始即出现，运行中 1s 心跳实时跳动；
 * run 结束定格（timing.endedAt，deriveTurnTimings 派生）。running 时数字呼吸。
 */
function TurnTimer({ timing, running }: { timing: TurnTiming; running: boolean }) {
	const t = useT();
	const [, tick] = useReducer((n: number) => n + 1, 0);
	// 仅运行轮跑心跳：组件随行卸载（切会话/行收起）自动清
	useEffect(() => {
		if (!running) return;
		const id = window.setInterval(tick, 1000);
		return () => window.clearInterval(id);
	}, [running]);
	const elapsed = running
		? Math.max(0, Date.now() - timing.startedAt)
		: timing.endedAt !== undefined
			? Math.max(0, timing.endedAt - timing.startedAt)
			: null;
	if (elapsed === null) return null;
	return (
		<span
			role="timer"
			className={`turn-diff-timer${running ? " turn-diff-timer-live" : ""}`}
			aria-label={t("diff.workedFor", { duration: formatDuration(elapsed) })}
		>
			<ClockIcon size={12} />
			<span className="turn-diff-timer-num">{formatDuration(elapsed)}</span>
		</span>
	);
}

/** 速度数值：>=100 取整，否则一位小数（tabular-nums 已防宽窄跳动） */
function formatSpeed(value: number): string {
	return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

/** 秒数（tooltip 用，保留一位） */
const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** token 规模缩写：1_250_000 → 1.25M，63_000 → 63k */
function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return String(value);
}

/**
 * 轮末生成速度（宿主原生，非插件）：紧跟计时器。
 * **口径必须上标**（dec / api）：api 含 prefill/网络，decode 已剔实测 prefill，
 * 同一轮两者可差 30%+；裸数字跨轮不可比。live = 流式期间估算值（≈ 前缀），权威值一到即覆盖。
 */
function TurnSpeed({ row }: { row: TurnSpeedRow }) {
	const t = useT();
	const live = row.live && row.liveSpeed !== null;
	const shown = live ? (row.liveSpeed as number) : row.speed;
	if (!(shown > 0) || !Number.isFinite(shown)) return null; // 宁缺勿错：无有效样本不挂假速度
	const parts = [t("diff.speedTitle", { speed: formatSpeed(shown), metric: row.metric })];
	if (row.apiSpeed !== null && row.apiSpeed !== shown) {
		parts.push(t("diff.speedApi", { speed: formatSpeed(row.apiSpeed) }));
	}
	if (row.decodeSpeed !== null && row.decodeSpeed !== shown) {
		parts.push(t("diff.speedDecode", { speed: formatSpeed(row.decodeSpeed) }));
	}
	if (row.prefillMs !== null) {
		parts.push(
			t("diff.speedPrefill", {
				prefill: formatSeconds(row.prefillMs),
				api: formatSeconds(row.apiMs ?? row.durationMs),
				duration: formatSeconds(row.durationMs),
			}),
		);
	}
	if (row.samples > 0) {
		parts.push(t("diff.speedSamples", { count: row.samples, prompt: formatTokens(row.promptTokens) }));
	}
	if (live) parts.push(t("diff.speedLive"));
	if (row.model) parts.push(row.model);
	const label = parts.join(" · ");
	return (
		// 只用 title（generic span 无 role，挂 aria-label 会被 AT 忽略并报 a11y；title 已是可及名来源）
		<span className={`turn-diff-speed${live ? " turn-diff-speed-live" : ""}`} title={label}>
			<BoltIcon size={12} />
			<span className="turn-diff-speed-num">
				{live ? "\u2248" : ""}
				{formatSpeed(shown)}
			</span>
			<span className="turn-diff-speed-unit">tok/s</span>
			<sup className="turn-diff-speed-metric">{row.metric === "decode" ? "dec" : "api"}</sup>
		</span>
	);
}

/**
 * 轮末行：计时恒在最前（每轮必有），文件变更 chip 条件渲染。
 * 有 diff 时整行 = details（点头部展开文件列表，drawer-details 同款动画，与 MetaGroup 一致）；
 * 无 diff 时 = 纯计时幽灵行。点文件行 / hover 浮出的「侧栏查看」→ 开侧栏并定位到对应文件卡。
 * entering = 该轮行刚出现（计时行随轮开始出现播 pop；历史回放/重渲染不播）。
 */
export function TurnDiffChip({
	changes,
	timing,
	speed,
	running,
	entering,
}: {
	changes?: TurnChanges;
	timing?: TurnTiming;
	speed?: TurnSpeedRow;
	running: boolean;
	entering: boolean;
}) {
	const t = useT();
	const setDiffSidebarOpen = useUiStore((s) => s.setDiffSidebarOpen);
	const setDiffFocus = useUiStore((s) => s.setDiffFocus);
	const sessionId = useSessionsStore((s) => s.activeSessionId);
	/** 相对路径文件行的解析基准（变更行里的路径是模型原样给出的，可能是相对的） */
	const cwd = useSessionsStore(selectActiveCwd);
	/** 文件行右键菜单：记住打开的那一行（target + 锚点） */
	const [menu, setMenu] = useState<{ path: string; cwd: string | null; anchor: MenuAnchor } | null>(null);
	const enterCls = entering ? " turn-diff-enter" : "";

	// 无变更轮：纯计时行（非交互，不占 details）
	if (!changes) {
		return timing ? (
			<div className={`turn-diff-plain${enterCls}`}>
				<TurnTimer timing={timing} running={running} />
				{speed && (
					<>
						<span className="turn-diff-sep" aria-hidden="true">
							·
						</span>
						<TurnSpeed row={speed} />
					</>
				)}
			</div>
		) : null;
	}

	const jumpTo = (sectionKey?: string) => {
		setDiffSidebarOpen(true);
		if (sectionKey) setDiffFocus(sectionKey, sessionId ?? undefined);
	};
	const fileCount = changes.files.length;

	return (
		<details className={`turn-diff drawer-details${enterCls}`}>
			<summary className="turn-diff-head">
				{timing && (
					<>
						<TurnTimer timing={timing} running={running} />
						<span className="turn-diff-sep" aria-hidden="true">
							·
						</span>
					</>
				)}
				{speed && (
					<>
						<TurnSpeed row={speed} />
						<span className="turn-diff-sep" aria-hidden="true">
							·
						</span>
					</>
				)}
				<span className="turn-diff-title">
					{t("diff.filesChanged", { count: fileCount, unit: pluralUnit(fileCount, "file", "files") })}
				</span>
				<span className="turn-diff-stat turn-diff-added">+{changes.totalAdded}</span>
				<span className="turn-diff-stat turn-diff-removed">−{changes.totalRemoved}</span>
				<span className="turn-diff-chev" aria-hidden="true">
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="m9 6 6 6-6 6" />
					</svg>
				</span>
			</summary>
			<div className="turn-diff-files">
				{changes.files.map((f) => (
					<button
						key={f.path}
						type="button"
						className="turn-diff-file"
						onClick={() => jumpTo(f.sections[0]?.toolCallKey)}
						onContextMenu={(e) => {
							e.preventDefault();
							setMenu({ path: f.path, cwd, anchor: anchorOfElement(e.currentTarget) });
						}}
					>
						<span className="turn-diff-path" title={f.path}>
							{/* LRM 前缀：RTL 截断时防路径开头的 "/" 被 bidi 算法甩到行尾 */}
							{`\u200e${f.path}`}
						</span>
						<span className="turn-diff-stat">
							<span className="turn-diff-added">+{f.added}</span>{" "}
							<span className="turn-diff-removed">−{f.removed}</span>
						</span>
						{/* hover 浮出的「⋯」：右键的可发现入口，与右键共用同一菜单。
						    主操作仍是左键跳 diff，这里是冗余入口（与胶囊叉叉同款：aria-hidden 的鼠标增强）。 */}
						<span
							className="turn-diff-more"
							aria-hidden="true"
							onClick={(e) => {
								e.stopPropagation();
								setMenu({ path: f.path, cwd, anchor: anchorOfElement(e.currentTarget) });
							}}
						>
							<MoreIcon />
						</span>
					</button>
				))}
			</div>
			{menu && (
				<FilePathMenu target={menu.path} cwd={menu.cwd} anchor={menu.anchor} onClose={() => setMenu(null)} />
			)}
		</details>
	);
}
