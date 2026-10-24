import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { Button } from "../ui/Button";

export function AddProjectDialog({
	onClose,
	onLocalProject,
}: {
	onClose: () => void;
	onLocalProject?: () => Promise<void>;
}) {
	const t = useT();
	return createPortal(
		<div
			role="dialog"
			aria-modal
			aria-label={t("sidebar.addProject")}
			className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20"
		>
			<div className="w-[360px] max-w-[calc(100vw-32px)] rounded-xl bg-surface p-5 shadow-dialog">
				<h2 className="text-ui-14 font-semibold text-ink">{t("sidebar.addProject")}</h2>
				<p className="mt-2 text-ui-12 text-ink-faint">{t("remote.projectLocationHint")}</p>
				<div className="mt-4 flex justify-end gap-2">
					<Button onClick={onClose}>{t("common.cancel")}</Button>
					<Button
						onClick={() => {
							onClose();
							void (onLocalProject ? onLocalProject() : useProjectsStore.getState().addProject());
						}}
					>
						{t("remote.localProject")}
					</Button>
					<Button
						onClick={() => {
							onClose();
							useRemoteConnectionStore.getState().setOpen(true);
						}}
					>
						{t("remote.remoteProject")}
					</Button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
