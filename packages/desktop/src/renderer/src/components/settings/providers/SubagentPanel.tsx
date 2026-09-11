import { isSubagentPackage, THINKING_LEVELS } from "@percho/shared";
import { useEffect } from "react";
import { type MessageKey, useT } from "../../../i18n";
import { useCatalogStore } from "../../../stores/catalog";
import { useSessionsStore } from "../../../stores/sessions";
import { useSettingsStore } from "../../../stores/settings";
import { Switch } from "../../ui/Switch";

const SELECT_CLASS =
	"w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink-faint";

/** 已配置包中疑似提供 subagent 能力的（npm: 前缀剥掉后按启发式判定，spec D5）。 */
function subagentPackageNames(packages: { source: string }[] | null): string[] {
	return [
		...new Set(
			(packages ?? [])
				.map((pkg) => pkg.source.replace(/^npm:/, ""))
				.filter((name) => isSubagentPackage({ name, description: "" })),
		),
	];
}

/** 子代理执行器开关 + 每个内置/用户级子代理的全局模型与思考深度覆盖。 */
export function SubagentPanel() {
	const t = useT();
	const loading = useSettingsStore((s) => s.loading);
	const subagents = useSettingsStore((s) => s.subagents);
	const prefs = useSettingsStore((s) => s.modelPrefs);
	const setSubagentModel = useSettingsStore((s) => s.setSubagentModel);
	const setSubagentThinking = useSettingsStore((s) => s.setSubagentThinking);
	const setSubagentPreferBuiltin = useSettingsStore((s) => s.setSubagentPreferBuiltin);
	const models = useSessionsStore((s) => s.models);
	const configuredPackages = useCatalogStore((s) => s.configuredPackages);
	const refreshConfiguredPackages = useCatalogStore((s) => s.refreshConfiguredPackages);

	// G4 静态提示数据源：进面板按需拉一次已配置包（null = 未加载；已加载则不重复请求）
	useEffect(() => {
		if (configuredPackages === null) void refreshConfiguredPackages();
	}, [configuredPackages, refreshConfiguredPackages]);

	if (loading && prefs === null) {
		return <p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.loading")}</p>;
	}

	const preferBuiltin = prefs?.subagentPreferBuiltin !== false;
	const conflicts = subagentPackageNames(configuredPackages);
	const thinkingLabel = (level: string) => t(`thinkingLevels.${level}` as MessageKey);

	return (
		<div>
			<div className="mb-4">
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.models.subagentExecutorTitle")}</h3>
					<Switch
						checked={preferBuiltin}
						disabled={prefs === null}
						onCheckedChange={(enabled) => void setSubagentPreferBuiltin(enabled)}
					/>
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
					{t("settings.models.subagentExecutorHint")}
				</p>
				{preferBuiltin && conflicts.length > 0 && (
					<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
						{t("settings.models.subagentExecutorConflictHint", { names: conflicts.join(", ") })}
					</p>
				)}
			</div>

			<p className="mb-3 text-[11px] text-ink-faint">{t("settings.models.subagentHint")}</p>
			{subagents.length === 0 ? (
				<p className="py-4 text-center text-[13px] text-ink-faint">{t("settings.models.subagentsEmpty")}</p>
			) : (
				<ul className="divide-y divide-border">
					{subagents.map((agent) => {
						const selected = prefs?.subagentModels[agent.name] ?? "";
						const hasSelectedModel = models.some((model) => `${model.provider}/${model.id}` === selected);
						const thinking = prefs?.subagentThinking?.[agent.name] ?? "";
						return (
							<li key={agent.name} className="py-3">
								<div className="mb-1.5">
									<p className="text-[13px] font-medium text-ink">{agent.name}</p>
									{agent.description && <p className="text-[11px] text-ink-faint">{agent.description}</p>}
								</div>
								<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
									<select
										className={SELECT_CLASS}
										value={selected}
										onChange={(event) => void setSubagentModel(agent.name, event.target.value || null)}
									>
										<option value="">{t("settings.models.inherit")}</option>
										{selected && !hasSelectedModel && <option value={selected}>{selected}</option>}
										{models.map((model) => (
											<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
												{model.providerName} · {model.label}
											</option>
										))}
									</select>
									<select
										className={SELECT_CLASS}
										value={thinking}
										onChange={(event) => void setSubagentThinking(agent.name, event.target.value || null)}
									>
										<option value="">
											{agent.thinking
												? t("settings.models.subagentThinkingInheritWith", {
														level: thinkingLabel(agent.thinking),
													})
												: t("settings.models.subagentThinkingInherit")}
										</option>
										{THINKING_LEVELS.map((level) => (
											<option key={level} value={level}>
												{thinkingLabel(level)}
											</option>
										))}
									</select>
								</div>
								{agent.thinkingWarning && (
									<p className="mt-1 text-[11px] text-ink-faint">
										{t("settings.models.subagentThinkingInvalid", { value: agent.thinkingWarning })}
									</p>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
