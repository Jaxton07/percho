import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { Switch } from "../ui/Switch";

/** 设置 → 局域网观察：仅展示本机只读 HTTP 服务的开关与访问入口。 */
export function LanObserverPanel() {
	const t = useT();
	const status = useSettingsStore((s) => s.lanStatus);
	const saving = useSettingsStore((s) => s.lanSaving);
	const refresh = useSettingsStore((s) => s.refreshLanStatus);
	const setEnabled = useSettingsStore((s) => s.setLanEnabled);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(() => {
		if (!status?.enabled) return;
		const timer = setInterval(() => void refresh(), 5000);
		return () => clearInterval(timer);
	}, [status?.enabled, refresh]);

	const url = status?.urls[0];
	const copyUrl = async () => {
		if (!url) return;
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			setCopied(false);
		}
	};

	return (
		<div className="flex flex-col gap-5">
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.lan.title")}</h3>
					<Switch
						checked={status?.enabled === true}
						disabled={saving || status === null}
						onCheckedChange={setEnabled}
					/>
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.lan.hint")}</p>
			</div>

			{status?.enabled && (
				<div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
					<div className="flex items-center justify-between text-[11px] text-ink-dim">
						<span>{t("settings.lan.port", { port: status.port ?? "—" })}</span>
						<span>{t("settings.lan.clients", { count: status.clients })}</span>
					</div>
					{url ? (
						<>
							<div className="flex gap-2">
								<input
									className="min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 py-1 text-[11px] text-ink"
									readOnly
									value={url}
								/>
								<button
									type="button"
									className="rounded-md border border-border px-2 text-[11px] text-ink-2 hover:bg-hover"
									onClick={() => void copyUrl()}
								>
									{copied ? t("settings.lan.copied") : t("settings.lan.copy")}
								</button>
							</div>
							{status.qrDataUrl && (
								<img
									className="mx-auto h-40 w-40 rounded bg-white p-2"
									src={status.qrDataUrl}
									alt={t("settings.lan.qrAlt")}
								/>
							)}
						</>
					) : (
						<p className="text-[11px] text-ink-faint">{t("settings.lan.noAddress")}</p>
					)}
				</div>
			)}

			<div className="rounded-lg border border-border bg-surface p-3 text-[11px] leading-relaxed text-ink-dim">
				<p className="font-medium text-ink-2">{t("settings.lan.securityTitle")}</p>
				<ul className="mt-1 list-disc space-y-1 pl-4">
					<li>{t("settings.lan.securityContent")}</li>
					<li>{t("settings.lan.securityTrusted")}</li>
					<li>{t("settings.lan.securityForward")}</li>
					<li>{t("settings.lan.securityFirewall")}</li>
				</ul>
			</div>
		</div>
	);
}
