import { type RemoteConnectionStatus, RUNTIME_NODE_RANGE } from "@percho/shared";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { ChevronRightIcon } from "../icons";

export function RemoteConnectionError({
	error,
	kind,
}: {
	error?: string;
	kind?: RemoteConnectionStatus["errorKind"];
}) {
	const t = useT();
	if (!error && !kind) return null;
	if (!error?.includes("NODE_REQUIRED"))
		return (
			<>
				{kind && <p className="mt-2 text-ui-12 text-ink-faint">{t(`remote.failure.${kind}`)}</p>}
				{error && <p className="mt-3 break-words text-ui-12 text-err">{error}</p>}
			</>
		);
	return (
		<div className="mt-3 space-y-2 text-ui-12" role="alert">
			<p className="text-err">{t("remote.nodeRequired.title")}</p>
			<p className="text-ink-2">{t("remote.nodeRequired.install", { version: RUNTIME_NODE_RANGE })}</p>
			<p className="text-ink-dim">{t("remote.nodeRequired.pathHint")}</p>
			<button
				type="button"
				className="rounded-lg px-2 py-1 font-medium text-ink-2 hover:bg-hover hover:text-ink"
				onClick={() => void getPi().openExternal({ url: "https://nodejs.org/en/download" })}
			>
				{t("remote.nodeRequired.download")}
			</button>
			<details className="group/details text-ui-115 text-ink-dim">
				<summary className="flex cursor-pointer list-none items-center gap-1 hover:text-ink [&::-webkit-details-marker]:hidden">
					<ChevronRightIcon className="shrink-0 group-open/details:rotate-90" />
					{t("remote.errorDetails")}
				</summary>
				<p className="mt-2 whitespace-pre-wrap break-words font-mono">{error}</p>
			</details>
		</div>
	);
}
