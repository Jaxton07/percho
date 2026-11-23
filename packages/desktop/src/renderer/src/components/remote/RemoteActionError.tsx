import { useT } from "../../i18n";

/** Keep raw transport diagnostics available without making them the default UI copy. */
export function RemoteActionError({ message }: { message: string }) {
	const t = useT();
	return (
		<details className="remote-note">
			<summary>{t("remote.ux.actionFailed")}</summary>
			<pre className="remote-code">{message}</pre>
		</details>
	);
}
