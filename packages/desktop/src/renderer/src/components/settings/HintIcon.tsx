import { useT } from "../../i18n";
import { QuestionIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

/** 标题旁的说明入口：说明文案收进问号，悬浮才显示 */
export function HintIcon({ label, align = "start" }: { label: string; align?: "center" | "start" | "end" }) {
	const t = useT();
	return (
		<Tooltip label={label} align={align} multiline>
			<span
				role="img"
				aria-label={t("settings.moreInfo")}
				className="inline-flex shrink-0 cursor-help text-ink-faint transition-colors hover:text-ink-dim"
			>
				<QuestionIcon size={13} />
			</span>
		</Tooltip>
	);
}
