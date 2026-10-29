import { useState } from "react";
import { ChevronDownIcon } from "../icons";
import { SelectionMenu } from "./SelectionMenu";

const SELECT_TRIGGER_CLASS =
	"flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-left text-ui-12 text-ink outline-none transition-colors hover:border-border-strong focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/** 无边框变体：设置页里当「右侧取值控件」用，视觉上与旁边的开关同一层级 */
const SELECT_TRIGGER_GHOST_CLASS =
	"flex w-auto items-center justify-end gap-2 rounded-lg bg-transparent px-2 py-1.5 text-right text-ui-12 text-ink outline-none transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:text-ink-faint";

export interface SelectOption {
	value: string;
	label: string;
}

/** 输入框样式的触发按钮；浮层、关闭行为和键盘导航统一由 SelectionMenu 承担。 */
export function Select({
	value,
	options,
	onChange,
	className = "",
	disabled,
	ariaLabel,
	variant = "default",
}: {
	value: string;
	options: readonly SelectOption[];
	onChange: (value: string) => void;
	className?: string;
	disabled?: boolean;
	ariaLabel?: string;
	/** default = 输入框样式；ghost = 无边框，用于设置页右侧取值 */
	variant?: "default" | "ghost";
}) {
	const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
	const current = options.find((option) => option.value === value);
	return (
		<>
			<button
				type="button"
				role="combobox"
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={anchor !== null}
				disabled={disabled}
				className={`${variant === "ghost" ? SELECT_TRIGGER_GHOST_CLASS : SELECT_TRIGGER_CLASS} ${className}`}
				onClick={(event) => {
					const trigger = event.currentTarget;
					setAnchor((previous) => (previous ? null : trigger));
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						setAnchor(event.currentTarget);
					}
				}}
			>
				<span className="truncate">{current?.label ?? value}</span>
				<ChevronDownIcon
					size={12}
					className={`ml-auto shrink-0 text-ink-dim transition-transform duration-150 motion-reduce:transition-none ${anchor !== null ? "rotate-180" : ""}`}
				/>
			</button>
			{anchor && (
				<SelectionMenu
					anchor={anchor}
					label={ariaLabel ?? current?.label ?? value}
					options={[...options]}
					value={value}
					onSelect={onChange}
					onClose={() => setAnchor(null)}
				/>
			)}
		</>
	);
}
