import type { AppInfo } from "@percho/shared";
import { useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useUpdateStore } from "../../stores/update";

/** 关于面板：应用标识 + 软件版本 + 检查更新 + 仓库入口，居中展示 */
export function AboutPanel() {
	const t = useT();
	const [info, setInfo] = useState<AppInfo | null>(null);
	const state = useUpdateStore((s) => s.state);

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

	// 状态行文案；downloaded 态按钮语义切换为「重启并安装」；manual 构建（mac 未正式签名）跳 release 页手动下载
	const statusText =
		state?.phase === "checking"
			? t("update.checking")
			: state?.phase === "available"
				? state.manual
					? t("update.availableManual", { version: state.version })
					: t("update.available", { version: state.version })
				: state?.phase === "downloading"
					? t("update.downloading", { percent: state.percent })
					: state?.phase === "downloaded"
						? t("update.downloaded")
						: state?.phase === "not-available"
							? t("update.upToDate")
							: state?.phase === "error"
								? t("update.checkFailed", { message: state.message })
								: null;

	const openReleasePage = async (version: string) => {
		const appInfo = info ?? (await getPi().getAppInfo());
		void getPi().openExternal(`${appInfo.repoUrl}/releases/tag/v${version}`);
	};

	const buttonLabel =
		state?.phase === "downloaded"
			? t("update.installNow")
			: state?.phase === "available" && state.manual
				? t("update.goDownload")
				: t("update.checkForUpdates");

	return (
		<div className="flex flex-col items-center gap-1.5 py-10 text-center">
			<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ink text-[16px] font-bold text-on-ink">
				P
			</div>
			<p className="mt-2 text-[14px] font-semibold text-ink">{info?.name ?? "Percho"}</p>
			<p className="text-[11px] text-ink-faint">{t("settings.about.poweredBy")}</p>
			<p className="mt-2 font-mono text-[12px] text-ink-dim">
				{t("settings.about.version")} {info?.version ?? "…"}
			</p>
			<div className="mt-4 flex items-center gap-2">
				<button
					type="button"
					className="rounded-lg border border-border px-4 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
					onClick={() => {
						if (state?.phase === "downloaded") void getPi().installUpdate();
						else if (state?.phase === "available" && state.manual) void openReleasePage(state.version);
						else void getPi().checkForUpdates();
					}}
				>
					{buttonLabel}
				</button>
				<button
					type="button"
					className="rounded-lg border border-border px-4 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
					onClick={() => {
						if (info?.repoUrl) void getPi().openExternal(info.repoUrl);
					}}
				>
					{t("settings.about.sourceCode")}
				</button>
			</div>
			{statusText && <p className="mt-1 text-[11px] text-ink-faint">{statusText}</p>}
		</div>
	);
}
