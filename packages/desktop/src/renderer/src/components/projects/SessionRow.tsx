import type { SessionMeta } from "@percho/shared";
import { useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useUiStore } from "../../stores/ui";
import { CheckIcon, CloseIcon, CopyIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";
import { buildDiagnosticsText } from "./diagnostics";

/** 历史会话行：点击打开，hover 出现复制诊断信息 + 删除（二次确认） */
export function SessionRow({ session }: { session: SessionMeta }) {
	const t = useT();
	const openSession = useProjectsStore((s) => s.openSession);
	const deleteSession = useProjectsStore((s) => s.deleteSession);
	const setView = useUiStore((s) => s.setView);
	const [confirming, setConfirming] = useState(false);
	const [copied, setCopied] = useState(false);

	const copyDiagnostics = async () => {
		try {
			// 版本经既有 AppGetInfo 通道取（无专用 getVersion IPC，S2 复用）；失败不阻塞其余字段
			const info = await getPi()
				.getAppInfo()
				.catch(() => null);
			const text = buildDiagnosticsText(session, {
				platform: getPi().platform,
				appVersion: info?.version ?? "unknown",
			});
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1800);
		} catch {
			// 剪贴板不可用（权限/非安全上下文）：静默
		}
	};

	return (
		<li className="group relative hover:z-10" onMouseLeave={() => setConfirming(false)}>
			{/* hover:z-10 —— 悬停行整体垫高：复制诊断气泡会从本行向下溢出到下一行，而每行都是
			    position:relative（z 为 auto），后续兄弟行会盖住气泡（z-50 被 -translate-y 产生的
			    层叠上下文困在本行内，出不去）。把悬停行抬到正层级，其内气泡即浮到相邻行之上。 */}
			<button
				type="button"
				className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
				onClick={() => {
					if (session.sessionFile) {
						void openSession(session).then(() => setView("chat"));
					}
				}}
			>
				<span className="min-w-0 flex-1 truncate text-[13px] text-ink">
					{session.name ?? t("projects.untitled")}
				</span>
				<span className="shrink-0 text-[11px] text-ink-faint group-hover:invisible">
					{t("projects.messages", { count: session.messageCount })}
				</span>
			</button>
			{/* 复制按钮：自研 Tooltip（替代 native title：延迟可控+样式统一）。定位类不能传给
			    Tooltip（其包裹层固定 relative，与 absolute 同置会冲突使包含块错乱、气泡被滚动容器
			    裁剪）——外层自套定位 span，Tooltip 在其内正常锦点 */}
			{/* flex items-center —— 修复图标垂直不居中：此 span 是 block，内容（inline-flex
			    气泡挂件）按行盒基线排布于高 21px 行盒顶部，图标被抬高约 3px。改 flex 后挂件
			    作为 flex item 垂直居中，图标回到行中线（与右侧删除 X 对齐）。 */}
			<span className="absolute right-10 top-1/2 -translate-y-1/2 flex items-center">
				<Tooltip label={t("projects.copyDiagnostics")} align="end">
					<button
						type="button"
						className="invisible rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-hover hover:text-ink-2 group-hover:visible"
						onClick={copyDiagnostics}
					>
						{copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
					</button>
				</Tooltip>
			</span>
			<button
				type="button"
				className={`invisible absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[11px] transition-colors group-hover:visible ${
					confirming ? "bg-red-50 text-red-600" : "text-ink-faint hover:bg-hover hover:text-ink-2"
				}`}
				onClick={() => {
					if (confirming) {
						void deleteSession(session);
					} else {
						setConfirming(true);
					}
				}}
			>
				{confirming ? t("projects.confirmDelete") : <CloseIcon />}
			</button>
		</li>
	);
}
