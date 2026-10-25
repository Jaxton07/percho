import { type EnvironmentRef, sameEnvironment } from "@percho/shared";
import { useT } from "../../i18n";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { ServerIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

/** 只表达环境归属；断线时仍保留，避免被误认为本机项目。 */
export function RemoteEnvironmentIndicator({ environment }: { environment: EnvironmentRef }) {
	const t = useT();
	const status = useRemoteConnectionStore((state) => state.status);
	if (environment.kind !== "ssh") return null;
	const label =
		status.environment && sameEnvironment(status.environment, environment)
			? `${t("remote.label")} · ${status.alias ?? t("remote.alias")}`
			: t("remote.unavailableProject");
	return (
		<Tooltip label={label} align="end">
			<span
				role="img"
				aria-label={label}
				data-remote-indicator
				className="inline-flex shrink-0 items-center text-ink-faint"
			>
				<ServerIcon size={13} />
			</span>
		</Tooltip>
	);
}
