import { type PatchHunk, parsePatch, type TurnFileChange } from "@percho/shared";
import { type CSSProperties, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";

/** 单卡 diff 超过此行数先折叠（「展开全部」按钮兜底），防长 diff 一次渲染刷屏 */
const COLLAPSE_LINES = 120;

/** diff 行（双 gutter 行号 + 符号列）；--i 供 stagger 进入动画延迟 */
function DiffLine({
	oldNo,
	newNo,
	kind,
	text,
	index,
}: {
	oldNo: number | null;
	newNo: number | null;
	kind: "ctx" | "add" | "del";
	text: string;
	index: number;
}) {
	const sign = kind === "add" ? "+" : kind === "del" ? "−" : " ";
	return (
		<div className={`diff-line diff-line-${kind}`} style={{ "--i": index } as CSSProperties}>
			<span className="diff-g">{oldNo ?? ""}</span>
			<span className="diff-g">{newNo ?? ""}</span>
			<span className="diff-code">
				{sign} {text}
			</span>
		</div>
	);
}

/** edit 段：unified patch 结构化渲染；解析失败（空 hunks）回退纯文本 pre */
function PatchView({ patch }: { patch: string }) {
	const t = useT();
	const hunks = useMemo(() => parsePatch(patch), [patch]);
	const [expanded, setExpanded] = useState(false);

	// 拍平成「hunk 头 / 行」序列并统一编号（stagger 的 --i），折叠按条数截断
	const flat = useMemo(() => {
		const out: ({ type: "hunk"; hunk: PatchHunk } | { type: "line"; hunk: PatchHunk; lineIndex: number })[] =
			[];
		for (const hunk of hunks) {
			out.push({ type: "hunk", hunk });
			hunk.lines.forEach((_, lineIndex) => {
				out.push({ type: "line", hunk, lineIndex });
			});
		}
		return out;
	}, [hunks]);

	if (hunks.length === 0) {
		return <pre className="diff-fallback">{patch}</pre>;
	}
	const overflow = flat.length - COLLAPSE_LINES;
	const visible = !expanded && overflow > 0 ? flat.slice(0, COLLAPSE_LINES) : flat;
	return (
		<>
			<div className="diff-table">
				{visible.map((entry, i) =>
					entry.type === "hunk" ? (
						<div key={`h${entry.hunk.oldStart}`} className="diff-hunk" style={{ "--i": i } as CSSProperties}>
							{entry.hunk.header}
						</div>
					) : (
						(() => {
							const ln = entry.hunk.lines[entry.lineIndex];
							if (!ln) return null;
							return (
								<DiffLine
									/* 行号对（oldNo/newNo）数据派生且 patch 内唯一：比数组下标更稳的 key */
									key={`l${ln.oldNo ?? "a"}-${ln.newNo ?? "d"}`}
									oldNo={ln.oldNo}
									newNo={ln.newNo}
									kind={ln.kind}
									text={ln.text}
									index={i}
								/>
							);
						})()
					),
				)}
			</div>
			{!expanded && overflow > 0 && (
				<button type="button" className="diff-more" onClick={() => setExpanded(true)}>
					{t("diff.expandMore", { lines: overflow })}
				</button>
			)}
		</>
	);
}

/** write 段：无改前内容，全量 + 行伪 diff（口径差异已在 spec 确认） */
function WriteView({ content }: { content: string }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const lines = useMemo(() => content.split("\n"), [content]);
	const overflow = lines.length - COLLAPSE_LINES;
	const visible = !expanded && overflow > 0 ? lines.slice(0, COLLAPSE_LINES) : lines;
	return (
		<>
			<div className="diff-table">
				{visible.map((text, i) => (
					/* biome-ignore lint/suspicious/noArrayIndexKey: write 伪 diff 是静态只增列表，下标即稳定标识 */
					<DiffLine key={i} oldNo={null} newNo={i + 1} kind="add" text={text} index={i} />
				))}
			</div>
			{!expanded && overflow > 0 && (
				<button type="button" className="diff-more" onClick={() => setExpanded(true)}>
					{t("diff.expandMore", { lines: overflow })}
				</button>
			)}
		</>
	);
}

/**
 * 文件卡片（手风琴）：头部 = mono path + 增删统计 + chevron；体 = sections 逐个渲染
 * （同轮同文件多次 edit 为多段，段间细分割线）。
 * <details> 非受控（drawer-details 抽屉动画）；内容体每次展开重挂（key=openCount）让行 stagger 重播。
 * chip 跳转由 DiffSidebar 直接操作 DOM（open=true + scrollIntoView + jump-flash），不经 props。
 */
export function DiffFileCard({ file, defaultOpen }: { file: TurnFileChange; defaultOpen: boolean }) {
	const ref = useRef<HTMLDetailsElement>(null);
	const [openCount, setOpenCount] = useState(0);

	// 非受控初值：挂载后补 open（不能用 open prop——React 重渲染会覆盖用户/程序的 DOM 侧切换）
	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时应用一次初值
	useEffect(() => {
		if (defaultOpen && ref.current) ref.current.open = true;
	}, []);

	return (
		<details
			ref={ref}
			className="diff-file-card drawer-details"
			data-section-key={file.sections[0]?.toolCallKey}
			onToggle={(e) => {
				if (e.currentTarget.open) setOpenCount((c) => c + 1);
			}}
		>
			<summary className="diff-file-head [&::-webkit-details-marker]:hidden">
				<svg
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					className="diff-file-icon"
					aria-hidden="true"
				>
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
					<path d="M14 2v6h6" />
				</svg>
				<span className="diff-file-path" title={file.path}>
					{/* LRM 前缀：RTL 截断时防路径开头的 "/" 被 bidi 算法甩到行尾 */}
					{`\u200e${file.path}`}
				</span>
				<span className="turn-diff-stat">
					<span className="turn-diff-added">+{file.added}</span>{" "}
					<span className="turn-diff-removed">−{file.removed}</span>
				</span>
				<span className="diff-file-chev" aria-hidden="true">
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
			<div className="diff-card-body" key={openCount}>
				{file.sections.map((sec, i) => (
					<Fragment key={sec.toolCallKey}>
						{i > 0 && <div className="diff-section-sep" aria-hidden="true" />}
						{sec.kind === "edit" && sec.patch ? (
							<PatchView patch={sec.patch} />
						) : (
							<WriteView content={sec.content ?? ""} />
						)}
					</Fragment>
				))}
			</div>
		</details>
	);
}
