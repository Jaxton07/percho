import type { LoadedSkill, ResourceScope } from "@percho/shared";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";

/** 来源作用域 badge：用户级中性色，项目级 accent 系，临时合成最弱 */
function ScopeBadge({ scope }: { scope: ResourceScope }) {
	const t = useT();
	const key =
		scope === "project"
			? "settings.skills.scopeProject"
			: scope === "temporary"
				? "settings.skills.scopeTemporary"
				: "settings.skills.scopeUser";
	return (
		<span
			className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
				scope === "project" ? "bg-accent/10 text-accent" : "bg-hover text-ink-2"
			}`}
		>
			{t(key)}
		</span>
	);
}

function SkillRow({ skill }: { skill: LoadedSkill }) {
	const t = useT();
	return (
		<li className="py-2.5">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{skill.name}</span>
				{skill.disableModelInvocation && (
					<span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ink-faint">
						{t("settings.skills.manualOnly")}
					</span>
				)}
				<ScopeBadge scope={skill.scope} />
			</div>
			{skill.description && (
				<p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-ink-dim">{skill.description}</p>
			)}
			<p className="mt-1 truncate font-mono text-[10px] text-ink-faint">{skill.path}</p>
		</li>
	);
}

/** Skills 设置面板：展示当前项目（活跃会话）已加载的 skills */
export function SkillsPanel() {
	const t = useT();
	const skills = useSettingsStore((s) => s.skills);
	const diagnostics = useSettingsStore((s) => s.skillDiagnostics);

	if (skills === null) {
		return (
			<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.skills.emptyNoSession")}</p>
		);
	}
	return (
		<div>
			<h3 className="text-[13px] font-medium text-ink">{t("settings.skills.title")}</h3>
			<p className="mt-0.5 text-[11px] text-ink-faint">{t("settings.skills.hint")}</p>
			{skills.length === 0 ? (
				<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.skills.empty")}</p>
			) : (
				<ul className="mt-3 divide-y divide-border">
					{skills.map((skill) => (
						<SkillRow key={skill.path} skill={skill} />
					))}
				</ul>
			)}
			{diagnostics.length > 0 && (
				<div className="mt-4">
					<p className="text-[11px] font-medium text-ink-2">{t("settings.skills.diagnostics")}</p>
					<ul className="mt-1 space-y-1">
						{diagnostics.map((d) => (
							<li key={d.path ?? d.message} className="text-[11px] leading-relaxed text-ink-dim">
								<span className={d.type === "error" ? "text-red-500" : "text-amber-500"}>{d.type}</span>
								{" — "}
								{d.message}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
