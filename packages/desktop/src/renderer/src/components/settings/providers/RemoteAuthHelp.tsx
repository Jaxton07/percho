import { type EnvironmentRef, environmentKey, type RemoteAuthGuide } from "@percho/shared";
import { useId, useState } from "react";
import { getPi } from "../../../api";
import { useEnvironment } from "../../../environment-context";
import { useT } from "../../../i18n";
import { useRemoteConnectionStore } from "../../../stores/remote-connection";
import { ChevronRightIcon } from "../../icons";
import { Button } from "../../ui/Button";

/** Instructions only: interactive credentials are entered in the user's own remote terminal. */
export function RemoteAuthHelp() {
	const environment = useEnvironment();
	if (environment.kind !== "ssh") return null;
	return <RemoteAuthHelpForEnvironment key={environmentKey(environment)} environment={environment} />;
}

function RemoteAuthHelpForEnvironment({
	environment,
}: {
	environment: Extract<EnvironmentRef, { kind: "ssh" }>;
}) {
	const t = useT();
	const available = useRemoteConnectionStore((state) =>
		state.catalog.records.some(
			(record) =>
				record.connectionId === environment.connectionId &&
				record.binding?.environmentId === environment.environmentId,
		),
	);
	const instructionsId = useId();
	const [expanded, setExpanded] = useState(false);
	const [guide, setGuide] = useState<RemoteAuthGuide | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	return (
		<div className="mb-3 rounded-lg bg-hover p-3 text-ui-12 text-ink-2">
			<p>{t("remote.authHint")}</p>
			<Button
				className="mt-1 inline-flex items-center gap-1.5"
				aria-expanded={expanded}
				aria-controls={instructionsId}
				onClick={() => {
					setExpanded(!expanded);
					if (expanded || guide || loading) return;
					if (!available) {
						setError(t("notifications.targetUnavailable"));
						return;
					}
					setLoading(true);
					setError("");
					void getPi()
						.remoteAuthGuide({ environment })
						.then(setGuide)
						.catch((error) => setError(error instanceof Error ? error.message : String(error)))
						.finally(() => setLoading(false));
				}}
			>
				<ChevronRightIcon className={expanded ? "rotate-90" : ""} />
				{t("remote.authInstructions")}
			</Button>
			<div id={instructionsId} hidden={!expanded}>
				{loading && (
					<p className="mt-2 text-ink-faint" role="status">
						{t("settings.loading")}
					</p>
				)}
				{!available && <p className="mt-2 break-words text-err">{t("notifications.targetUnavailable")}</p>}
				{guide && available && (
					<div className="mt-2 space-y-2">
						<p>{t("remote.authStopFirst")}</p>
						<pre className="whitespace-pre-wrap break-all select-text">{guide.sshCommand}</pre>
						<p>{t("remote.authRunRemotely")}</p>
						<pre className="whitespace-pre-wrap break-all select-text">{guide.authCommand}</pre>
						<p>{t("remote.authFinish")}</p>
						<p className="break-all select-text">{guide.agentDir}</p>
					</div>
				)}
				{error && available && <p className="mt-2 break-words text-err">{error}</p>}
			</div>
		</div>
	);
}
