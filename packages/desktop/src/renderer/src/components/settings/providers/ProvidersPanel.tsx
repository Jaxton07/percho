import type { ProviderInfo } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";
import { RefreshIcon } from "../../icons";
import { CustomProviderForm } from "./CustomProviderForm";
import { LoginDialog } from "./LoginDialog";
import { IconAction, ProviderRow } from "./ProviderRow";
import { SubagentPanel } from "./SubagentPanel";

type ModelSettingsTab = "providers" | "subagents";

/** 模型配置：Provider 目录/可见性与子代理模型覆盖。 */
export function ProvidersPanel() {
	const t = useT();
	const [tab, setTab] = useState<ModelSettingsTab>("providers");
	const providers = useSettingsStore((s) => s.providers);
	const loading = useSettingsStore((s) => s.loading);
	const refreshing = useSettingsStore((s) => s.refreshing);
	const refreshFromNetwork = useSettingsStore((s) => s.refreshProvidersFromNetwork);
	const error = useSettingsStore((s) => s.error);

	return (
		<div>
			<div className="mb-3 flex gap-1 border-b border-border">
				{(["providers", "subagents"] as const).map((id) => (
					<button
						key={id}
						type="button"
						className={`px-2.5 py-1.5 text-[12px] transition-colors ${
							tab === id ? "border-b-2 border-ink text-ink" : "text-ink-faint hover:text-ink"
						}`}
						onClick={() => setTab(id)}
					>
						{t(`settings.models.${id}`)}
					</button>
				))}
			</div>
			{tab === "subagents" ? (
				<SubagentPanel />
			) : (
				<>
					<div className="mb-2 flex items-center justify-between gap-2">
						<p className="text-[11px] text-ink-faint">{t("settings.providers.catalogHint")}</p>
						<IconAction
							label={t("settings.providers.refresh")}
							align="end"
							disabled={loading || refreshing}
							onClick={() => void refreshFromNetwork()}
						>
							{refreshing ? (
								<span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
							) : (
								<RefreshIcon />
							)}
						</IconAction>
					</div>
					{error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600">{error}</p>}
					{loading && providers.length === 0 ? (
						<p className="py-8 text-center text-[13px] text-ink-faint">{t("settings.loading")}</p>
					) : (
						<ProviderList providers={providers} />
					)}
					<CustomProviderForm />
					<LoginDialog />
				</>
			)}
		</div>
	);
}

function ProviderList({ providers }: { providers: ProviderInfo[] }) {
	const t = useT();
	if (providers.length === 0) {
		return <p className="py-4 text-center text-[13px] text-ink-faint">{t("settings.providers.empty")}</p>;
	}
	return (
		<ul className="divide-y divide-border">
			{providers.map((provider) => (
				<ProviderRow key={provider.id} provider={provider} />
			))}
		</ul>
	);
}
