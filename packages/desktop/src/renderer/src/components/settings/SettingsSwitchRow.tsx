import { Switch } from "../ui/Switch";
import { HintIcon } from "./HintIcon";

/**
 * 设置页的「标题 + 问号说明 + 右侧开关」行。
 * 说明文案默认收进标题旁的问号（悬浮显示），避免长段落把面板撑成阅读页。
 */
export function SettingsSwitchRow({
	title,
	hint,
	checked,
	disabled,
	onCheckedChange,
}: {
	title: string;
	hint?: string;
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-4">
			<div className="flex min-w-0 items-center gap-1.5">
				<h3 className="truncate text-ui-13 font-medium text-ink">{title}</h3>
				{hint && <HintIcon label={hint} />}
			</div>
			<Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
		</div>
	);
}
