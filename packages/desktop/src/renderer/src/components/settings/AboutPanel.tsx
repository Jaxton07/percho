import type { AppInfo } from "@pi-desktop/shared";
import { useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";

/** 关于面板：应用标识 + 软件版本 + 仓库入口，居中展示 */
export function AboutPanel() {
	const t = useT();
	const [info, setInfo] = useState<AppInfo | null>(null);

	useEffect(() => {
		let cancelled = false;
		void getPi()
			.getAppInfo()
			.then((appInfo) => {
				if (!cancelled) setInfo(appInfo);
			})
			.catch(() => {
				if (!cancelled) setInfo(null);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div className="flex flex-col items-center gap-1.5 py-10 text-center">
			<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink text-[16px] font-bold text-on-ink">
				Pi
			</div>
			<p className="mt-2 text-[14px] font-semibold text-ink">{info?.name ?? "Pi Desktop"}</p>
			<p className="text-[11px] text-ink-faint">{t("settings.about.poweredBy")}</p>
			<p className="mt-2 font-mono text-[12px] text-ink-dim">
				{t("settings.about.version")} {info?.version ?? "…"}
			</p>
			<button
				type="button"
				className="mt-4 rounded-lg border border-border px-4 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
				onClick={() => {
					if (info?.repoUrl) void getPi().openExternal(info.repoUrl);
				}}
			>
				{t("settings.about.sourceCode")}
			</button>
		</div>
	);
}
