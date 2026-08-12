import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useUpdateStore } from "../../stores/update";
import { DownloadIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

const RING_RADIUS = 8.5;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 顶栏更新按钮：无更新不渲染；发现新版=下载图标+角标（点击开始下载），下载中=淡蓝进度环，下载完=「重启」胶囊（点击安装重启） */
export function UpdateButton() {
	const t = useT();
	const state = useUpdateStore((s) => s.state);
	if (!state) return null;
	if (state.phase !== "available" && state.phase !== "downloading" && state.phase !== "downloaded") {
		return null;
	}

	const label =
		state.phase === "downloading"
			? t("update.downloading", { percent: state.percent })
			: state.phase === "downloaded"
				? t("update.installNow")
				: t("update.available", { version: state.version });

	if (state.phase === "downloaded") {
		return (
			<Tooltip label={label}>
				<button
					type="button"
					aria-label={label}
					className="no-drag flex h-5 shrink-0 items-center rounded-full bg-update px-2 text-[11px] font-medium text-on-update transition-colors hover:brightness-95"
					onClick={() => void getPi().installUpdate()}
				>
					{t("update.restart")}
				</button>
			</Tooltip>
		);
	}

	return (
		<Tooltip label={label}>
			<button
				type="button"
				aria-label={label}
				className="no-drag relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-update transition-colors hover:bg-hover hover:text-ink"
				onClick={() => {
					if (state.phase === "available") void getPi().checkForUpdates();
				}}
			>
				{state.phase === "downloading" ? (
					<svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90" aria-hidden="true">
						<circle
							cx="10"
							cy="10"
							r={RING_RADIUS}
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							className="opacity-25"
						/>
						<circle
							cx="10"
							cy="10"
							r={RING_RADIUS}
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeDasharray={CIRCUMFERENCE}
							strokeDashoffset={CIRCUMFERENCE * (1 - state.percent / 100)}
						/>
					</svg>
				) : (
					<DownloadIcon size={14} />
				)}
				{state.phase === "available" && (
					<span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-update ring-1 ring-canvas" />
				)}
			</button>
		</Tooltip>
	);
}
