import { KNOWN_UI_REGIONS, KNOWN_UI_SLOTS, type UiPluginInfo } from "@percho/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { type MessageKey, useT } from "../../i18n";
import { useUiPluginsStore } from "../../stores/ui-plugins";
import { FolderIcon, RefreshIcon } from "../icons";
import { Dropdown } from "../ui/Dropdown";
import { Switch } from "../ui/Switch";
import { Tooltip } from "../ui/Tooltip";

/** 槽位名 → i18n key（KNOWN_UI_SLOTS 与 renderer slots.ts 对齐） */
const SLOT_KEYS: Record<string, MessageKey> = {
	"chat.tool-call-card": "settings.uiPlugins.slotToolCallCard",
	"chat.subagent-card": "settings.uiPlugins.slotSubagentCard",
	"chat.todo-panel": "settings.uiPlugins.slotTodoPanel",
};

/** 区域名 → i18n key（KNOWN_UI_REGIONS 与 renderer slots.ts 对齐） */
const REGION_KEYS: Record<string, MessageKey> = {
	"app.background": "settings.uiPlugins.regionAppBackground",
	"app.overlay": "settings.uiPlugins.regionAppOverlay",
	"chat.corner.top-left": "settings.uiPlugins.regionCornerTopLeft",
	"chat.corner.top-right": "settings.uiPlugins.regionCornerTopRight",
	"chat.corner.bottom-left": "settings.uiPlugins.regionCornerBottomLeft",
	"chat.corner.bottom-right": "settings.uiPlugins.regionCornerBottomRight",
	"settings.panel": "settings.uiPlugins.regionSettingsPanel",
};

const REGION_NAMES = new Set(KNOWN_UI_REGIONS);

/** 行内启用按钮：未信任时先二次确认（照 ExtensionsPanel UninstallButton 模式，3s 恢复） */
function EnableButton({ plugin }: { plugin: UiPluginInfo }) {
	const t = useT();
	const [confirming, setConfirming] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const setPluginEnabled = useUiPluginsStore((s) => s.setPluginEnabled);

	if (confirming) {
		return (
			<button
				type="button"
				className="rounded-lg px-2 py-1 text-[12px] font-medium text-red-500 transition-colors hover:text-red-600"
				onClick={() => {
					clearTimeout(timerRef.current);
					void setPluginEnabled(plugin.name, true);
				}}
				onMouseLeave={() => setConfirming(false)}
			>
				{t("settings.uiPlugins.confirmEnable")}
			</button>
		);
	}
	return (
		<button
			type="button"
			className="rounded-lg px-2 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-hover"
			onClick={() => {
				setConfirming(true);
				clearTimeout(timerRef.current);
				timerRef.current = setTimeout(() => setConfirming(false), 3000);
			}}
		>
			{t("settings.uiPlugins.enable")}
		</button>
	);
}

/** 单插件行：信息 + 状态 badge + 操作（启用确认/停用/重建/打开目录）；错误红字展开区 */
function PluginRow({ plugin }: { plugin: UiPluginInfo }) {
	const t = useT();
	const setPluginEnabled = useUiPluginsStore((s) => s.setPluginEnabled);
	const rebuild = useUiPluginsStore((s) => s.rebuild);
	const openDir = useUiPluginsStore((s) => s.openDir);
	const loadError = useUiPluginsStore((s) => s.loadErrors[plugin.name]);
	const [rebuilding, setRebuilding] = useState(false);

	const slotNames = Object.keys(plugin.slots)
		.map((slot) => t((SLOT_KEYS[slot] ?? slot) as MessageKey))
		.join(" · ");
	const contributionNames = plugin.contributions
		.filter((c) => REGION_NAMES.has(c.region)) // 与面板展示同源（未知 region 已被 main 过滤，双保险）
		.map((c) => `${c.title ?? c.id}（${t((REGION_KEYS[c.region] ?? c.region) as MessageKey)}）`)
		.join(" · ");
	// 状态 badge 优先级：清单无效 > 构建失败 > 加载失败 > 已启用 > 未信任
	const badge = plugin.invalidReason
		? { text: t("settings.uiPlugins.statusInvalid"), cls: "bg-red-100 text-red-600" }
		: plugin.buildError
			? { text: t("settings.uiPlugins.statusBuildFailed"), cls: "bg-red-100 text-red-600" }
			: loadError
				? { text: t("settings.uiPlugins.statusLoadFailed"), cls: "bg-red-100 text-red-600" }
				: plugin.enabled
					? { text: t("settings.uiPlugins.statusEnabled"), cls: "bg-green-100 text-green-700" }
					: { text: t("settings.uiPlugins.statusUntrusted"), cls: "bg-border text-ink-faint" };

	return (
		<div className="rounded-xl border border-border bg-surface p-3">
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate text-[13px] font-medium text-ink">
							{plugin.displayName ?? plugin.name}
						</span>
						<span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>
							{badge.text}
						</span>
						{plugin.builtin && (
							<span className="shrink-0 rounded-md bg-hover px-1.5 py-0.5 text-[10px] font-medium text-ink-2">
								{t("settings.uiPlugins.builtinBadge")}
							</span>
						)}
					</div>
					<div className="mt-0.5 truncate text-[11px] text-ink-faint">
						<span className="font-mono">{plugin.name}</span>
						{plugin.version ? ` · v${plugin.version}` : ""}
						{slotNames ? ` · ${t("settings.uiPlugins.slotsLabel")} ${slotNames}` : ""}
						{contributionNames ? ` · ${t("settings.uiPlugins.contributionsLabel")} ${contributionNames}` : ""}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{plugin.enabled ? (
						<button
							type="button"
							className="rounded-lg px-2 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover"
							onClick={() => void setPluginEnabled(plugin.name, false)}
						>
							{t("settings.uiPlugins.disable")}
						</button>
					) : (
						<EnableButton plugin={plugin} />
					)}
					<Tooltip label={t("settings.uiPlugins.rebuild")}>
						<button
							type="button"
							className="rounded-lg p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
							aria-label={t("settings.uiPlugins.rebuild")}
							disabled={rebuilding || !!plugin.invalidReason}
							onClick={() => {
								setRebuilding(true);
								void rebuild(plugin.name).finally(() => setRebuilding(false));
							}}
						>
							{rebuilding ? (
								<span className="block h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
							) : (
								<RefreshIcon size={13} />
							)}
						</button>
					</Tooltip>
					<Tooltip label={t("settings.uiPlugins.openDir")}>
						<button
							type="button"
							className="rounded-lg p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
							aria-label={t("settings.uiPlugins.openDir")}
							onClick={() => void openDir(plugin.name)}
						>
							<FolderIcon size={13} />
						</button>
					</Tooltip>
				</div>
			</div>
			{(plugin.invalidReason || plugin.buildError || loadError) && (
				<div className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] leading-relaxed break-words text-red-600 select-text">
					{plugin.invalidReason ?? plugin.buildError ?? loadError}
				</div>
			)}
		</div>
	);
}

/** 槽位指派区：仅显示被多个启用插件争抢的槽位 */
function AssignmentSection() {
	const t = useT();
	const plugins = useUiPluginsStore((s) => s.plugins);
	const config = useUiPluginsStore((s) => s.config);
	const assignSlot = useUiPluginsStore((s) => s.assignSlot);

	const contested = useMemo(() => {
		const enabled = plugins.filter((p) => p.enabled && !p.invalidReason && !p.buildError);
		return KNOWN_UI_SLOTS.filter((slot) => enabled.filter((p) => p.slots[slot] !== undefined).length > 1);
	}, [plugins]);

	if (contested.length === 0) return null;
	return (
		<div>
			<h3 className="text-[13px] font-medium text-ink">{t("settings.uiPlugins.assignmentTitle")}</h3>
			<p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.uiPlugins.assignmentHint")}</p>
			<div className="mt-2 flex flex-col gap-2">
				{contested.map((slot) => {
					const contenders = plugins.filter((p) => p.slots[slot] !== undefined);
					const current = config.assignments[slot];
					return (
						<div
							key={slot}
							className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
						>
							<span className="text-[12px] text-ink-2">{t((SLOT_KEYS[slot] ?? slot) as MessageKey)}</span>
							<Dropdown
								trigger={
									<span className="text-[12px] text-ink">
										{current ?? t("settings.uiPlugins.assignmentNone")}
									</span>
								}
							>
								{(close) => (
									<>
										{contenders.map((p) => (
											<button
												key={p.name}
												type="button"
												className={`block w-full rounded-lg px-2 py-1 text-left text-[12px] transition-colors hover:bg-hover ${
													current === p.name ? "text-accent" : "text-ink"
												}`}
												onClick={() => {
													void assignSlot(slot, p.name);
													close();
												}}
											>
												{p.displayName ?? p.name}
											</button>
										))}
										<button
											type="button"
											className="block w-full rounded-lg px-2 py-1 text-left text-[12px] text-ink-faint transition-colors hover:bg-hover"
											onClick={() => {
												void assignSlot(slot, null);
												close();
											}}
										>
											{t("settings.uiPlugins.assignmentNone")}
										</button>
									</>
								)}
							</Dropdown>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** UI 插件面板：总开关 / 插件列表 / 槽位指派（spec §12） */
export function UiPluginsPanel() {
	const t = useT();
	const config = useUiPluginsStore((s) => s.config);
	const plugins = useUiPluginsStore((s) => s.plugins);
	const setMaster = useUiPluginsStore((s) => s.setMaster);
	const openDir = useUiPluginsStore((s) => s.openDir);

	useEffect(() => {
		void useUiPluginsStore.getState().loadAll();
	}, []);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between gap-4">
				<div>
					<h3 className="text-[13px] font-medium text-ink">{t("settings.uiPlugins.title")}</h3>
					<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
						{t("settings.uiPlugins.masterHint")}
					</p>
				</div>
				<Switch checked={config.enabled} onCheckedChange={(enabled) => void setMaster(enabled)} />
			</div>

			{plugins.length === 0 ? (
				<div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
					<p className="text-[12px] leading-relaxed text-ink-2">{t("settings.uiPlugins.empty")}</p>
					<p className="mt-1 text-[11px] text-ink-faint">{t("settings.uiPlugins.agentHint")}</p>
					<button
						type="button"
						className="mt-3 rounded-lg border border-border px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
						onClick={() => void openDir()}
					>
						{t("settings.uiPlugins.openDir")}
					</button>
				</div>
			) : (
				<>
					<div className="flex flex-col gap-2">
						{plugins.map((p) => (
							<PluginRow key={p.name} plugin={p} />
						))}
					</div>
					<AssignmentSection />
				</>
			)}
		</div>
	);
}
