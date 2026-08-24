import type { TurnChanges } from "@percho/shared";
import { useT } from "../../i18n";
import { useUiStore } from "../../stores/ui";
import { DiffIcon } from "../icons";

/** en 复数单位（与 MetaGroup 的 pluralUnit 同规则） */
const pluralUnit = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * 轮末文件变更 chip（codex 同款）：「修改了 N 个文件 +a −d ›」。
 * 点击头部 = 抽屉展开/收起文件列表（drawer-details 同款动画，与 MetaGroup 一致）；
 * 点文件行 / hover 浮出的「侧栏查看」→ 开侧栏并定位到对应文件卡。
 * entering = 该轮 chip 刚出现（turn_end 后），播放 pop 进场动画；历史回放/重渲染不播。
 */
export function TurnDiffChip({ changes, entering }: { changes: TurnChanges; entering: boolean }) {
	const t = useT();
	const setDiffSidebarOpen = useUiStore((s) => s.setDiffSidebarOpen);
	const setDiffFocus = useUiStore((s) => s.setDiffFocus);
	const fileCount = changes.files.length;

	const jumpTo = (sectionKey?: string) => {
		setDiffSidebarOpen(true);
		if (sectionKey) setDiffFocus(sectionKey);
	};

	return (
		<details className={`turn-diff drawer-details${entering ? " turn-diff-enter" : ""}`}>
			<summary className="turn-diff-head">
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
				{/* hover 浮出的「侧栏查看」：真 button（键盘可达），阻止冒泡防触发 summary 折叠切换 */}
				<button
					type="button"
					className="turn-diff-open-side"
					tabIndex={-1}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						jumpTo(changes.files[0]?.sections[0]?.toolCallKey);
					}}
				>
					<DiffIcon size={11} />
					{t("diff.openSidebar")}
				</button>
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
