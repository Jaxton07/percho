import { useT } from "../../../i18n";
import { useSessionsStore } from "../../../stores/sessions";
import { useSettingsStore } from "../../../stores/settings";

/** 每个内置/用户级子代理的全局模型覆盖；空值即运行时继承父会话模型。 */
export function SubagentPanel() {
	const t = useT();
	const loading = useSettingsStore((s) => s.loading);
	const subagents = useSettingsStore((s) => s.subagents);
	const prefs = useSettingsStore((s) => s.modelPrefs);
	const setSubagentModel = useSettingsStore((s) => s.setSubagentModel);
	const models = useSessionsStore((s) => s.models);

	if (loading && prefs === null) {
		return <p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.loading")}</p>;
	}
	if (subagents.length === 0) {
		return (
			<p className="py-4 text-center text-[13px] text-ink-faint">{t("settings.models.subagentsEmpty")}</p>
		);
	}

	return (
		<div>
			<p className="mb-3 text-[11px] text-ink-faint">{t("settings.models.subagentHint")}</p>
			<ul className="divide-y divide-border">
				{subagents.map((agent) => {
					const selected = prefs?.subagentModels[agent.name] ?? "";
					const hasSelectedModel = models.some((model) => `${model.provider}/${model.id}` === selected);
					return (
						<li key={agent.name} className="py-3">
							<div className="mb-1.5">
								<p className="text-[13px] font-medium text-ink">{agent.name}</p>
								{agent.description && <p className="text-[11px] text-ink-faint">{agent.description}</p>}
							</div>
							<select
								className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink-faint"
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
						</li>
					);
				})}
			</ul>
		</div>
	);
}
