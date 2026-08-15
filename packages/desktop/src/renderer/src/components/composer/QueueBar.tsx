import { useT } from "../../i18n";
import { UndoIcon } from "../icons";

/** 排队消息条：显示首条排队文本，hover 出现「取回」按钮（点掉后内容放回输入框继续编辑） */
export function QueueBar({ text, onRestore }: { text: string; onRestore: () => void }) {
	const t = useT();
	return (
		<div className="group/queue relative mb-1.5 flex items-center gap-2 overflow-hidden rounded-xl bg-surface px-3 py-1.5 shadow-soft">
			<span className="shrink-0 text-[12px] text-ink-faint">{t("composer.queueTitle")}</span>
			<span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{text}</span>
			{/* 撤销层：hover 行才显示；渐变模糊压住下方文字，仅镂空图标可点（防误点） */}
			<div className="pointer-events-none absolute inset-y-0 right-0 flex w-14 items-center justify-end pr-2.5 opacity-0 transition-opacity group-hover/queue:opacity-100">
				<span
					className="absolute inset-0 bg-gradient-to-l from-surface/60 to-transparent backdrop-blur-[3px] [mask-image:linear-gradient(to_left,black_45%,transparent)]"
					aria-hidden="true"
				/>
				<button
					type="button"
					className="pointer-events-auto relative flex items-center justify-center text-ink-faint transition-colors hover:text-ink-2"
					aria-label={t("composer.queueRestore")}
					onClick={onRestore}
				>
					<UndoIcon size={14} />
				</button>
			</div>
		</div>
	);
}
