import { type EnvironmentRef, sameEnvironment } from "@percho/shared";
import { useT } from "../../i18n";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { ServerIcon } from "../icons";
import { Tooltip } from "../ui/Tooltip";

/** 只表达环境归属；断线时仍保留，避免被误认为本机项目。 */
export function RemoteEnvironmentIndicator({ environment }: { environment: EnvironmentRef }) {
	const t = useT();
	const status = useRemoteConnectionStore((state) => state.status);
	const records = useRemoteConnectionStore((state) => state.catalog.records);
	if (environment.kind !== "ssh") return null;
	const record = records.find(
		(item) =>
			item.connectionId === environment.connectionId &&
			item.binding?.environmentId === environment.environmentId,
	);
	const online =
		status.state === "connected" && status.environment && sameEnvironment(status.environment, environment);
	const alias =
		record?.alias ??
		(status.environment && sameEnvironment(status.environment, environment) ? status.alias : undefined);
	const label = alias
		? `${t("remote.label")} · ${alias}${online ? "" : ` · ${t("remote.disconnected")}`}`
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
