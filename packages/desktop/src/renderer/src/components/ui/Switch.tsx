import type { ComponentProps } from "react";

export interface SwitchProps
	extends Omit<ComponentProps<"button">, "children" | "onClick" | "role" | "type"> {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}

/** 统一的设置开关：受控、键盘可达、disabled 时保持原生禁用语义。 */
export function Switch({ checked, onCheckedChange, className = "", disabled, ...props }: SwitchProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onCheckedChange(!checked)}
			className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
				checked ? "bg-ink" : "bg-border-strong"
			} disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
			{...props}
		>
			<span
				className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-all ${
					checked ? "left-[18px]" : "left-0.5"
				}`}
			/>
		</button>
	);
}
