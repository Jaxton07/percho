import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useSessionSwitchDiagnostics } from "../../stores/session-switch-diagnostics";

export function SessionSwitchDiagnostics() {
	const t = useT();
	const busy = useSessionSwitchDiagnostics((state) => state.busy);
	const progress = useSessionSwitchDiagnostics((state) => state.progress);
	const failed = useSessionSwitchDiagnostics((state) => state.failed);
	const report = useSessionSwitchDiagnostics((state) => state.report);
	const start = useSessionSwitchDiagnostics((state) => state.start);
	return (
		<div className="mt-4 flex max-w-md flex-col items-center gap-2 text-ui-11 text-ink-faint">
			<p>{t("settings.about.switchDiagnosticsHint")}</p>
			<button
				type="button"
				data-session-switch-diagnostics="run"
				disabled={busy}
				className="rounded-lg px-3 py-1 text-ui-12 hover:bg-hover disabled:opacity-40"
				onClick={() => {
					void start();
				}}
			>
				{busy ? `${progress}%` : t("settings.about.switchDiagnosticsRun")}
			</button>
			{failed && <p role="alert">{t("settings.about.switchDiagnosticsError")}</p>}
			{report && (
				<>
					<p>{t("settings.about.switchDiagnosticsDone")}</p>
					<button
						type="button"
						className="rounded-lg px-3 py-1 text-ui-12 hover:bg-hover"
						onClick={() => {
							void getPi().saveFileDialog({
								defaultName: "session-switch-diagnostics.json",
								content: JSON.stringify(report, null, 2),
							});
						}}
					>
						{t("settings.about.switchDiagnosticsExport")}
					</button>
				</>
			)}
		</div>
	);
}
