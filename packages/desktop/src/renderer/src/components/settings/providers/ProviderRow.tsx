import type { ProviderInfo } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";
import { EditIcon, ExpandArrowIcon, LoginIcon, TestIcon, TrashIcon } from "../../icons";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/Switch";
import { Tooltip } from "../../ui/Tooltip";
import { CustomProviderEditForm } from "./CustomProviderForm";

const EMPTY_MODEL_IDS: string[] = [];

/** 图标操作按钮：图标无文字，Tooltip + aria-label 必需（ProvidersPanel 刷新按钮复用） */
export function IconAction({
	label,
	align,
	danger,
	disabled,
	onClick,
	children,
}: {
	label: string;
	/** 透传给 Tooltip：靠滚动容器右缘的按钮用 "end"，居中气泡会向右溢出被裁 */
	align?: "center" | "end";
	danger?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Tooltip label={label} align={align}>
			<button
				type="button"
				aria-label={label}
				disabled={disabled}
				className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
					danger
						? "text-ink-dim hover:bg-red-50 hover:text-red-600"
						: "text-ink-dim hover:bg-hover hover:text-ink"
				}`}
				onClick={onClick}
			>
				{children}
			</button>
		</Tooltip>
	);
}

/** 单个 Provider：配置状态徽章 + 图标操作（测试 / 填 Key / 删除 / 移除凭证） */
export function ProviderRow({ provider }: { provider: ProviderInfo }) {
	const t = useT();
	const saveKey = useSettingsStore((s) => s.saveKey);
	const removeCredential = useSettingsStore((s) => s.removeCredential);
	const removeCustom = useSettingsStore((s) => s.removeCustom);
	const test = useSettingsStore((s) => s.test);
	const startLogin = useSettingsStore((s) => s.startProviderLogin);
	const loginActive = useSettingsStore((s) => s.login !== null);
	const testResult = useSettingsStore((s) => s.testResults[provider.id]);
	const hiddenModelIds = useSettingsStore((s) => s.modelPrefs?.hiddenModels[provider.id] ?? EMPTY_MODEL_IDS);
	const setModelHidden = useSettingsStore((s) => s.setModelHidden);
	const setModelsHidden = useSettingsStore((s) => s.setModelsHidden);
	/** 批量开关三态：全可见 / 全隐藏 / 部分隐藏（中间态点击 = 一键全隐藏，方便先藏再挑） */
	const hiddenCount = provider.models.filter((m) => hiddenModelIds.includes(m.id)).length;
	const allVisible = hiddenCount === 0;
	const allHidden = hiddenCount > 0 && hiddenCount === provider.models.length;
	const mixed = !allVisible && !allHidden;
	/** 自定义 provider 展开全字段编辑表单，内置 provider 只填/更新 Key */
	const [editing, setEditing] = useState(false);
	const [modelsOpen, setModelsOpen] = useState(false);
	const [key, setKey] = useState("");

	const save = async () => {
		if (!key.trim()) return;
		await saveKey(provider.id, key);
		setEditing(false);
		setKey("");
	};

	return (
		<li className="py-2.5">
			<div className="flex items-center gap-1">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate text-[13px] font-medium text-ink">{provider.name}</span>
						{provider.custom && (
							<span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-ink-dim">
								{t("settings.providers.custom")}
							</span>
						)}
					</div>
					<div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-faint">
						{provider.configured ? (
							<button
								type="button"
								className="flex items-center gap-1 rounded hover:text-ink"
								onClick={() => setModelsOpen((open) => !open)}
								aria-expanded={modelsOpen}
							>
								{t("settings.providers.modelCount", { count: provider.models.length })}
								<ExpandArrowIcon className={`transition-transform ${modelsOpen ? "rotate-90" : ""}`} />
							</button>
						) : (
							<span>{t("settings.providers.modelCount", { count: provider.models.length })}</span>
						)}
						{provider.configured && provider.authLabel ? ` · ${provider.authLabel}` : ""}
					</div>
				</div>
				<span
					className={`mr-1 shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
						provider.configured ? "bg-emerald-50 text-emerald-600" : "bg-hover text-ink-faint"
					}`}
				>
					{provider.configured ? t("settings.providers.configured") : t("settings.providers.unconfigured")}
				</span>
				{provider.configured && (
					<IconAction
						label={t("settings.providers.test")}
						disabled={testResult === "testing"}
						onClick={() => void test(provider.id)}
					>
						{testResult === "testing" ? (
							<span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
						) : (
							<TestIcon />
						)}
					</IconAction>
				)}
				{provider.oauth && !provider.custom && (
					<IconAction
						label={provider.oauth.loginLabel ?? t("settings.providers.login")}
						disabled={loginActive}
						onClick={() => void startLogin(provider)}
					>
						<LoginIcon />
					</IconAction>
				)}
				<IconAction
					label={
						provider.custom
							? t("settings.providers.editCustom")
							: provider.configured
								? t("settings.providers.updateKey")
								: t("settings.providers.configKey")
					}
					onClick={() => setEditing((v) => !v)}
				>
					<EditIcon />
				</IconAction>
				{provider.custom ? (
					<IconAction label={t("common.delete")} danger onClick={() => void removeCustom(provider.id)}>
						<TrashIcon />
					</IconAction>
				) : (
					provider.configured &&
					provider.authSource === "stored" && (
						<IconAction
							label={t("settings.providers.removeCredential")}
							danger
							onClick={() => void removeCredential(provider.id)}
						>
							<TrashIcon />
						</IconAction>
					)
				)}
				{/* 行末批量开关：一键全显示/全隐藏该 provider 的所有模型（openrouter 这类几百个模型的供应商先全藏再挑）。
					tooltip 右对齐（align=end）：开关紧贴滚动容器右缘，居中气泡会向右溢出 */}
				<Tooltip
					label={
						allHidden
							? t("settings.providers.showAllModels", { name: provider.name })
							: t("settings.providers.hideAllModels", { name: provider.name })
					}
					align="end"
				>
					<Switch
						checked={allVisible}
						indeterminate={mixed}
						disabled={provider.models.length === 0}
						onCheckedChange={() =>
							void setModelsHidden(
								provider.id,
								provider.models.map((m) => m.id),
								!allHidden,
							)
						}
						aria-label={
							allHidden
								? t("settings.providers.showAllModels", { name: provider.name })
								: t("settings.providers.hideAllModels", { name: provider.name })
						}
					/>
				</Tooltip>
			</div>
			{testResult && testResult !== "testing" && (
				<p
					className={`mt-1.5 rounded-lg px-2.5 py-1.5 text-[11px] ${
						testResult.ok ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
					}`}
				>
					{testResult.ok
						? t("settings.providers.testOk", { modelId: testResult.modelId ?? "" })
						: t("settings.providers.testFailed", { error: testResult.error ?? "" })}
				</p>
			)}
			{provider.configured && modelsOpen && provider.models.length > 0 && (
				<div className="mt-2 rounded-lg bg-hover/60 px-2.5 py-2">
					<p className="mb-1 text-[10px] font-medium text-ink-faint">
						{t("settings.providers.modelVisibility")}
					</p>
					<ul className="space-y-0.5">
						{provider.models.map((model) => {
							const visible = !hiddenModelIds.includes(model.id);
							return (
								<li key={model.id}>
									<div className="flex items-center gap-2 rounded px-1 py-1 text-[11px] text-ink-dim hover:bg-surface">
										<span className="min-w-0 flex-1 truncate">{model.name}</span>
										<Switch
											checked={visible}
											onCheckedChange={(nextVisible) =>
												void setModelHidden(provider.id, model.id, !nextVisible)
											}
										/>
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			)}
			{editing &&
				(provider.custom ? (
					<div className="mt-2">
						<CustomProviderEditForm provider={provider} onDone={() => setEditing(false)} />
					</div>
				) : (
					<div className="mt-2 flex items-center gap-2">
						<input
							type="password"
							className="min-w-0 flex-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint"
							placeholder={t("settings.providers.keyPlaceholder")}
							value={key}
							onChange={(e) => setKey(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && void save()}
						/>
						<Button variant="primary" onClick={() => void save()} disabled={!key.trim()}>
							{t("common.save")}
						</Button>
					</div>
				))}
		</li>
	);
}
