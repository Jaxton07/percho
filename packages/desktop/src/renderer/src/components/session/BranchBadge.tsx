import { useEffect, useState } from "react";
import { getPi } from "../../api";
import { useSessionsStore } from "../../stores/sessions";
import { useTranscriptStore } from "../../stores/transcript";

/**
 * 分支悬浮胶囊：消息区左上角，显示当前会话 cwd 的 git 分支（与右上角 TodoPanel 对称）。
 * 只读展示——点击展开本地分支列表（当前分支高亮圆点），不做切换（空态 Composer 下方的
 * ProjectBranchPicker 才是切换入口）。新会话（无消息且未在流式）不显示，避免与
 * 输入框下方的分支选择器重复。
 *
 * 卡片形态照抄 TodoPanel：折叠 = 小胶囊，展开 = 面板，grid-rows 0fr→1fr 内部抽拉 +
 * 宽度过渡。数据用 getPi().listGitBranches（backend 已有 IPC，无新增通道）。
 */
export function BranchBadge() {
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const cwd = useSessionsStore((s) => s.cwd);
	// 有内容才显示：与 App 的 showEmpty 同判定（无 entry / 无消息且未流式 → 空）
	const hasContent = useTranscriptStore((s) => {
		const entry = activeSessionId ? s.bySession[activeSessionId] : undefined;
		return !!entry && (entry.messages.length > 0 || entry.streaming);
	});

	const [branches, setBranches] = useState<string[]>([]);
	const [current, setCurrent] = useState<string | null>(null);
	const [open, setOpen] = useState(false);

	// cwd 变化（切会话/切项目）即刷新；展开时也重拉一次（分支可能在终端被切走）
	useEffect(() => {
		if (!cwd || !hasContent) return;
		let cancelled = false;
		void getPi()
			.listGitBranches(cwd)
			.then((r) => {
				if (cancelled) return;
				setBranches(r.branches);
				setCurrent(r.current);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [cwd, hasContent, open]);

	// 点击外部关闭（Dropdown 同款）
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const hit = e.target instanceof Element ? e.target.closest("[data-branch-badge]") : null;
			if (!hit) setOpen(false);
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [open]);

	// 非 git 目录（current=null）/ 新会话 / 无 cwd → 不渲染
	if (!hasContent || !cwd || !current || branches.length === 0) return null;

	return (
		<div className="absolute top-2 left-4 z-20" data-branch-badge>
			<div
				className={`overflow-hidden rounded-xl bg-surface shadow-pop transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
					open ? "w-56" : "w-40"
				}`}
			>
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
					className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
				>
					<span aria-hidden="true" className="shrink-0 text-[13px] leading-5 text-ink-faint">
						⎇
					</span>
					<span className="shrink-0 truncate text-[13px] font-medium text-ink-dim">{current}</span>
				</button>
				<div
					className={`grid w-56 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none ${
						open ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0"
					}`}
					aria-hidden={!open}
				>
					<div className="overflow-hidden">
						<ul className="max-h-72 overflow-y-auto px-1.5 pt-1 pb-1.5">
							{branches.map((branch) => {
								const isCurrent = branch === current;
								return (
									// 只读列表：不做 hover/点击态，避免「看起来能切、实际不生效」的假交互
									<li
										key={branch}
										className={`flex items-center gap-2 rounded-md px-2 py-1 text-[13px] ${
											isCurrent ? "font-medium text-ink" : "text-ink-2"
										}`}
									>
										<span
											aria-hidden="true"
											className={`h-1.5 w-1.5 shrink-0 rounded-full ${isCurrent ? "bg-ink-2" : "bg-transparent"}`}
										/>
										<span className="min-w-0 truncate">{branch}</span>
									</li>
								);
							})}
						</ul>
					</div>
				</div>
			</div>
		</div>
	);
}
