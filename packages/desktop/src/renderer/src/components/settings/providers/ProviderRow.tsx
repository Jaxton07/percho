import type { ProviderInfo } from "@pi-desktop/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";
import { EditIcon, TestIcon, TrashIcon } from "../../icons";
import { Button } from "../../ui/Button";
import { Tooltip } from "../../ui/Tooltip";

/** 图标操作按钮：图标无文字，Tooltip + aria-label 必需（ProvidersPanel 刷新按钮复用） */
export function IconAction({
	label,
	danger,
	disabled,
	onClick,
	children,
}: {
	label: string;
	danger?: boolean;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<Tooltip label={label}>
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
	const testResult = useSettingsStore((s) => s.testResults[provider.id]);
	const [editing, setEditing] = useState(false);
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
					<div className="mt-0.5 text-[11px] text-ink-faint">
						{t("settings.providers.modelCount", { count: provider.models.length })}
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
				<IconAction
					label={provider.configured ? t("settings.providers.updateKey") : t("settings.providers.configKey")}
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
			{editing && (
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
			)}
		</li>
	);
}
