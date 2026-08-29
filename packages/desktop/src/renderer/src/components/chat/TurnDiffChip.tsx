import type { TurnChanges, TurnTiming } from "@percho/shared";
import { useEffect, useReducer } from "react";
import { useT } from "../../i18n";
import { useUiStore } from "../../stores/ui";
import { ClockIcon } from "../icons";

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

/**
 * 轮末行：计时恒在最前（每轮必有），文件变更 chip 条件渲染。
 * 有 diff 时整行 = details（点头部展开文件列表，drawer-details 同款动画，与 MetaGroup 一致）；
 * 无 diff 时 = 纯计时幽灵行。点文件行 / hover 浮出的「侧栏查看」→ 开侧栏并定位到对应文件卡。
 * entering = 该轮行刚出现（计时行随轮开始出现播 pop；历史回放/重渲染不播）。
 */
export function TurnDiffChip({
	changes,
	timing,
	running,
	entering,
}: {
	changes?: TurnChanges;
	timing?: TurnTiming;
	running: boolean;
	entering: boolean;
}) {
	const t = useT();
	const setDiffSidebarOpen = useUiStore((s) => s.setDiffSidebarOpen);
	const setDiffFocus = useUiStore((s) => s.setDiffFocus);
	const enterCls = entering ? " turn-diff-enter" : "";

	// 无变更轮：纯计时行（非交互，不占 details）
	if (!changes) {
		return timing ? (
			<div className={`turn-diff-plain${enterCls}`}>
				<TurnTimer timing={timing} running={running} />
			</div>
		) : null;
	}

	const jumpTo = (sectionKey?: string) => {
		setDiffSidebarOpen(true);
		if (sectionKey) setDiffFocus(sectionKey);
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
					>
						<span className="turn-diff-path" title={f.path}>
							{/* LRM 前缀：RTL 截断时防路径开头的 "/" 被 bidi 算法甩到行尾 */}
							{`\u200e${f.path}`}
						</span>
						<span className="turn-diff-stat">
							<span className="turn-diff-added">+{f.added}</span>{" "}
							<span className="turn-diff-removed">−{f.removed}</span>
						</span>
					</button>
				))}
			</div>
		</details>
	);
}
