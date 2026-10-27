import { useT } from "../../i18n";
import { UndoIcon } from "../icons";

/** 排队消息条：按受理顺序展示，取回时仍一次恢复完整队列。 */
export function QueueBar({ texts, onRestore }: { texts: readonly string[]; onRestore: () => void }) {
	const t = useT();
	return (
		<div className="group/queue relative mb-1.5 flex items-center gap-2 overflow-hidden rounded-xl bg-surface px-3 py-1.5 shadow-soft">
			<span className="shrink-0 text-ui-12 text-ink-faint">{t("composer.queueTitle")}</span>
			<div className="min-w-0 max-h-24 flex-1 overflow-y-auto whitespace-pre-line break-words text-ui-13 text-ink-2 thin-scrollbar">
				{texts.join("\n")}
			</div>
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
