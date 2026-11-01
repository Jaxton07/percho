import { isSubagentPackage, THINKING_LEVELS } from "@percho/shared";
import { useEffect } from "react";
import { type MessageKey, useT } from "../../../i18n";
import { useCatalogStore } from "../../../stores/catalog";
import { useSessionsStore } from "../../../stores/sessions";
import { useSettingsStore } from "../../../stores/settings";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";

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
		return <p className="py-8 text-center text-ui-13 text-ink-faint">{t("settings.loading")}</p>;
	}

	const preferBuiltin = prefs?.subagentPreferBuiltin !== false;
	const conflicts = subagentPackageNames(configuredPackages);
	const thinkingLabel = (level: string) => t(`thinkingLevels.${level}` as MessageKey);

	return (
		<div>
			<div className="mb-4">
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-ui-13 font-medium text-ink">{t("settings.models.subagentExecutorTitle")}</h3>
					<Switch
						checked={preferBuiltin}
						disabled={prefs === null}
						onCheckedChange={(enabled) => void setSubagentPreferBuiltin(enabled)}
					/>
				</div>
				<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">
					{t("settings.models.subagentExecutorHint")}
				</p>
				{preferBuiltin && conflicts.length > 0 && (
					<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">
						{t("settings.models.subagentExecutorConflictHint", { names: conflicts.join(", ") })}
					</p>
				)}
			</div>

			<p className="mb-3 text-ui-11 text-ink-faint">{t("settings.models.subagentHint")}</p>
			{subagents.length === 0 ? (
				<p className="py-4 text-center text-ui-13 text-ink-faint">{t("settings.models.subagentsEmpty")}</p>
			) : (
				<ul className="divide-y divide-border">
					{subagents.map((agent) => {
						const selected = prefs?.subagentModels[agent.name] ?? "";
						const hasSelectedModel = models.some((model) => `${model.provider}/${model.id}` === selected);
						const thinking = prefs?.subagentThinking?.[agent.name] ?? "";
						return (
							<li key={agent.name} className="py-3">
								<div className="mb-1.5">
									<p className="text-ui-13 font-medium text-ink">{agent.name}</p>
									{agent.description && <p className="text-ui-11 text-ink-faint">{agent.description}</p>}
								</div>
								<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
									<Select
										value={selected}
										options={[
											{ value: "", label: t("settings.models.inherit") },
											...(selected && !hasSelectedModel ? [{ value: selected, label: selected }] : []),
											...models.map((model) => ({
												value: `${model.provider}/${model.id}`,
												label: `${model.providerName} · ${model.label}`,
											})),
										]}
										onChange={(value) => void setSubagentModel(agent.name, value || null)}
									/>
									<Select
										value={thinking}
										options={[
											{
												value: "",
												label: agent.thinking
													? t("settings.models.subagentThinkingInheritWith", {
															level: thinkingLabel(agent.thinking),
														})
													: t("settings.models.subagentThinkingInherit"),
											},
											...THINKING_LEVELS.map((level) => ({ value: level, label: thinkingLabel(level) })),
										]}
										onChange={(value) => void setSubagentThinking(agent.name, value || null)}
									/>
								</div>
								{agent.denyWarnings?.length ? (
									<p className="mt-1 text-ui-11 text-ink-faint">
										{t("settings.models.subagentDenyInvalid", { value: agent.denyWarnings.join(", ") })}
									</p>
								) : null}
								{agent.thinkingWarning && (
									<p className="mt-1 text-ui-11 text-ink-faint">
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
