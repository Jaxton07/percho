import type { PermissionMode } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { CheckIcon, ShieldIcon, WarningIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

/** 档位定义：glyph / 标题 / 描述（spec permission-mode §6） */
const MODES: PermissionMode[] = ["default", "fullAccess"];

/**
 * 会话权限档位 chip（仿 ModelPicker：按钮 + 上弹层 + 外部点击/Esc 关闭）。
 * 模式按会话隔离（切 tab 跟随各会话档位）；enabled=false（手改 permissions.json 的
 * 逃生舱态）时禁用 + Tooltip 指路。fullAccess 激活时 warn 色 glyph 常驻可瞥见提醒。
 */
export function PermissionPicker() {
	const t = useT();
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const mode = useSessionsStore((s) => s.permissionModes[s.activeSessionId ?? ""] ?? "default");
	const setSessionPermissionMode = useSessionsStore((s) => s.setSessionPermissionMode);
	const gateOff = useSettingsStore((s) => s.permissionGateOff);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const chip = (
		<button
			type="button"
			className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-hover ${
				mode === "fullAccess" ? "text-warn hover:text-warn" : "text-ink-dim hover:text-ink"
			} ${gateOff ? "cursor-not-allowed opacity-40 hover:bg-transparent" : ""}`}
			aria-label={t("composer.permissionMode")}
			disabled={gateOff === true}
			onClick={() => setOpen((v) => !v)}
		>
			{mode === "fullAccess" ? <WarningIcon size={12} /> : <ShieldIcon size={12} />}
			<span>
				{mode === "fullAccess" ? t("composer.permissionFullAccess") : t("composer.permissionDefault")}
			</span>
		</button>
	);

	return (
		<div ref={ref} className="relative">
			{gateOff === true ? (
				<Tooltip label={t("composer.permissionGateOff")} align="end">
					{chip}
				</Tooltip>
			) : (
				chip
			)}
			{open && !gateOff && (
				<div className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-xl bg-surface p-1 shadow-pop">
					{MODES.map((m) => {
						const selected = mode === m;
						return (
							<button
								key={m}
								type="button"
								className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
									selected ? "text-ink" : "text-ink-2 hover:bg-hover"
								}`}
								onClick={() => {
									if (activeSessionId) void setSessionPermissionMode(activeSessionId, m);
									setOpen(false);
								}}
							>
								{m === "fullAccess" ? (
									<WarningIcon size={13} className="mt-0.5 shrink-0 text-warn" />
								) : (
									<ShieldIcon size={13} className="mt-0.5 shrink-0 text-ink-dim" />
								)}
								<span className="min-w-0 flex-1">
									<span className="block text-xs font-medium">
										{m === "fullAccess"
											? t("composer.permissionFullAccessTitle")
											: t("composer.permissionDefaultTitle")}
									</span>
									<span className="mt-0.5 block text-[11px] leading-relaxed text-ink-faint">
										{m === "fullAccess"
											? t("composer.permissionFullAccessDesc")
											: t("composer.permissionDefaultDesc")}
									</span>
								</span>
								{selected && <CheckIcon size={12} className="mt-1 shrink-0" />}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
