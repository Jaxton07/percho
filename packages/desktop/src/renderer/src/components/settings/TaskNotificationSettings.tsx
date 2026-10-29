import { useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { Switch } from "../ui/Switch";

export function TaskNotificationSettings() {
	const t = useT();
	const enabled = useUiPreferencesStore((s) => s.taskNotificationsEnabled);
	const setEnabled = useUiPreferencesStore((s) => s.setTaskNotificationsEnabled);
	const [result, setResult] = useState<"submitted" | "unsupported" | "failed" | null>(null);
	const [sending, setSending] = useState(false);
	const test = async () => {
		setSending(true);
		setResult(null);
		try {
			setResult(await getPi().testTaskNotification());
		} catch {
			setResult("failed");
		} finally {
			setSending(false);
		}
	};
	return (
		<section>
			<div className="flex items-center justify-between gap-4">
				<h3 className="text-ui-13 font-medium text-ink">{t("notifications.title")}</h3>
				<Switch checked={enabled} onCheckedChange={(value) => void setEnabled(value)} />
			</div>
			<button
				type="button"
				disabled={sending}
				onClick={() => void test()}
				className="mt-2 rounded-lg px-2 py-1 text-ui-12 text-ink-dim hover:bg-hover disabled:opacity-50"
			>
				{t("notifications.test")}
			</button>
			{result && (
				<p role="status" className="mt-1 text-ui-11 text-ink-faint">
					{t(`notifications.${result}`)}
				</p>
			)}
		</section>
	);
}
