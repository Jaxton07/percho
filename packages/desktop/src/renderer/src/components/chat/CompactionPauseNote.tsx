import type { CompactionPause } from "@percho/shared";
import { useT } from "../../i18n";

const reasonKeys = {
	failed: "compaction.paused.failed",
	"still-over-threshold": "compaction.paused.overThreshold",
	"nothing-to-compact": "compaction.paused.noHistory",
	"context-changed": "compaction.paused.contextChanged",
} as const;

/** 当前运行状态独立于持久历史；重连后由同一后端快照恢复。 */
export function CompactionPauseNote({ pause }: { pause: CompactionPause }) {
	const t = useT();
	return (
		<div role="status" className="flex flex-col gap-1 text-ui-12 text-ink-dim">
			<p>{t(reasonKeys[pause.reason])}</p>
			{pause.errorMessage && <p className="break-words text-ink-faint">{pause.errorMessage}</p>}
			<p className="text-ink-faint">{t("compaction.paused.resumeHint")}</p>
		</div>
	);
}
