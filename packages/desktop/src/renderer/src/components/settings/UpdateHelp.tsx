import type { UpdateDiagnosticsInfo } from "@percho/shared";
import { useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { pushToast } from "../../stores/toasts";

/** 导出为用户显式操作，无自动上传；不把缺少安装结果当作确定失败。 */
export function UpdateHelp({
	diagnostics,
	windows,
	repoUrl,
}: {
	diagnostics: UpdateDiagnosticsInfo | null;
	windows: boolean;
	repoUrl: string;
}) {
	const t = useT();
	const [exporting, setExporting] = useState(false);
	const exportReport = async () => {
		setExporting(true);
		try {
			const path = await getPi().exportUpdateDiagnostics();
			if (path) pushToast("info", "update.diagnosticsSaved", path);
		} catch (error) {
			pushToast("error", "update.diagnosticsFailed", error instanceof Error ? error.message : String(error));
		} finally {
			setExporting(false);
		}
	};
	return (
		<section className="mt-5 flex max-w-md flex-col items-center gap-2 text-ui-12 text-ink-dim">
			<h3 className="font-medium text-ink-2">{t("update.helpTitle")}</h3>
			{diagnostics?.previousInstall === "unconfirmed" && (
				<p>{t("update.installUnconfirmed", { version: diagnostics.targetVersion ?? "" })}</p>
			)}
			{windows && <p>{t("update.windowsRecovery")}</p>}
			<p className="text-ui-11 text-ink-faint">{t("update.diagnosticsPrivacy")}</p>
			<div className="flex items-center gap-2">
				<button
					type="button"
					disabled={exporting}
					className="rounded-lg px-2 py-1 text-ink-2 transition-colors hover:bg-hover disabled:opacity-50"
					onClick={() => void exportReport()}
				>
					{t(exporting ? "update.exportingDiagnostics" : "update.exportDiagnostics")}
				</button>
				<button
					type="button"
					className="rounded-lg px-2 py-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					onClick={() => void getPi().openExternal({ url: `${repoUrl}/releases/latest` })}
				>
					{t("update.manualInstaller")}
				</button>
			</div>
		</section>
	);
}
