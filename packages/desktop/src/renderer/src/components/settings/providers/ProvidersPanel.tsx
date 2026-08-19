import type { ProviderInfo } from "@percho/shared";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";
import { RefreshIcon } from "../../icons";
import { CustomProviderForm } from "./CustomProviderForm";
import { LoginDialog } from "./LoginDialog";
import { IconAction, ProviderRow } from "./ProviderRow";

/** Provider 设置面板：列表 + 联网刷新 + 自定义 provider 表单 */
export function ProvidersPanel() {
	const t = useT();
	const providers = useSettingsStore((s) => s.providers);
	const loading = useSettingsStore((s) => s.loading);
	const refreshing = useSettingsStore((s) => s.refreshing);
	const refreshFromNetwork = useSettingsStore((s) => s.refreshProvidersFromNetwork);
	const error = useSettingsStore((s) => s.error);

	return (
		<div>
			<div className="mb-2 flex items-center justify-between gap-2">
				<p className="text-[11px] text-ink-faint">{t("settings.providers.catalogHint")}</p>
				<IconAction
					label={t("settings.providers.refresh")}
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
