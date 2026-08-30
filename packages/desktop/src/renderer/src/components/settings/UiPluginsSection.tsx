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
				className="rounded-lg px-2 py-1 text-[12px] font-medium text-err transition-colors hover:bg-hover"
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
			className="rounded-lg px-2 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover"
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

/**
 * 单插件行（设计稿 ③）：无边框 soft 卡；状态 = 一枚 8px 状态点
 * （绿=已启用 / 灰=未信任 / 红=清单无效·构建失败·加载失败）；错误详情 bg-hover mono 块
 */
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

	const errorText = plugin.invalidReason ?? plugin.buildError ?? loadError;
	const errorLabel = plugin.invalidReason
		? t("settings.uiPlugins.statusInvalid")
		: plugin.buildError
			? t("settings.uiPlugins.statusBuildFailed")
			: loadError
				? t("settings.uiPlugins.statusLoadFailed")
				: null;
	// 状态点优先级：异常（红）> 已启用（绿）> 未信任（中性灰）
	const statusDot = errorText ? "bg-err" : plugin.enabled ? "bg-ok" : "bg-ink-faint";

	return (
		<div className="rounded-xl bg-surface p-3 shadow-soft">
			<div className="flex items-center gap-2">
				<span className={`h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
				<span className="truncate text-[13px] font-medium text-ink">{plugin.displayName ?? plugin.name}</span>
				{plugin.builtin && (
					<span className="shrink-0 rounded-md border border-border px-1 text-[10px] leading-[15px] text-ink-faint">
						{t("settings.uiPlugins.builtinBadge")}
					</span>
				)}
				<div className="ml-auto flex shrink-0 items-center gap-1">
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
			<div className="mt-0.5 truncate pl-4 text-[11px] text-ink-faint">
				<span className="font-mono">{plugin.name}</span>
				{plugin.version ? ` · v${plugin.version}` : ""}
				{slotNames ? ` · ${t("settings.uiPlugins.slotsLabel")} ${slotNames}` : ""}
				{contributionNames ? ` · ${t("settings.uiPlugins.contributionsLabel")} ${contributionNames}` : ""}
			</div>
			{errorText && (
				<div className="ml-4 mt-2 rounded-lg bg-hover px-2.5 py-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-ink-dim select-text">
					<div className="font-sans text-err">{errorLabel}</div>
					{errorText}
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
						<div key={slot} className="rounded-xl bg-surface px-3 py-2 shadow-soft">
							<div className="flex items-center justify-between gap-2">
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
						</div>
					);
				})}
			</div>
		</div>
	);
}

/**
 * UI 插件子页（设计稿 ②④）：总开关 + 插件列表 + 槽位指派（spec §12）。
 * 总开关关 → 列表整体收起为一行元信息「N 个插件 · 打开目录」（文件与配置保留）。
 */
export function UiPluginsSection() {
	const t = useT();
	const config = useUiPluginsStore((s) => s.config);
	const plugins = useUiPluginsStore((s) => s.plugins);
	const setMaster = useUiPluginsStore((s) => s.setMaster);
	const openDir = useUiPluginsStore((s) => s.openDir);

	useEffect(() => {
		void useUiPluginsStore.getState().loadAll();
	}, []);

	return (
		<div>
			<div className="flex items-center justify-between gap-4">
				<h3 className="text-[13px] font-medium text-ink">{t("settings.uiPlugins.title")}</h3>
				<Switch checked={config.enabled} onCheckedChange={(enabled) => void setMaster(enabled)} />
			</div>
			<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
				{t("settings.uiPlugins.masterHint")}
			</p>

			{!config.enabled ? (
				<p className="mt-2.5 text-[11px] text-ink-faint">
					{t("settings.uiPlugins.pluginCount", { count: plugins.length })} ·{" "}
					<button
						type="button"
						className="rounded text-ink-faint underline decoration-border-strong underline-offset-2 transition-colors hover:text-ink-2"
						onClick={() => void openDir()}
					>
						{t("settings.uiPlugins.openDir")}
					</button>
				</p>
			) : plugins.length === 0 ? (
				<div className="px-4 py-6 text-center">
					<p className="text-[12px] leading-relaxed text-ink-2">{t("settings.uiPlugins.empty")}</p>
					<p className="mt-1 text-[11px] text-ink-faint">{t("settings.uiPlugins.agentHint")}</p>
					<button
						type="button"
						className="mt-3 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ink-dim transition-colors hover:bg-hover hover:text-ink"
						onClick={() => void openDir()}
					>
						{t("settings.uiPlugins.openDir")}
					</button>
				</div>
			) : (
				<div className="mt-2.5 flex flex-col gap-5">
					<div className="flex flex-col gap-2">
						{plugins.map((p) => (
							<PluginRow key={p.name} plugin={p} />
						))}
					</div>
					<AssignmentSection />
				</div>
			)}
		</div>
	);
}
