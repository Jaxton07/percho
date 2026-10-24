import { useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { Button } from "../ui/Button";

export function RemoteConnectionDialog() {
	const open = useRemoteConnectionStore((state) => state.open);
	return open ? <RemoteConnectionBody /> : null;
}
function RemoteConnectionBody() {
	const t = useT();
	const status = useRemoteConnectionStore((state) => state.status);
	const connect = useRemoteConnectionStore((state) => state.connect);
	const disconnect = useRemoteConnectionStore((state) => state.disconnect);
	const openProject = useRemoteConnectionStore((state) => state.openProject);
	const checkOperation = useRemoteConnectionStore((state) => state.checkOperation);
	const dismissOperation = useRemoteConnectionStore((state) => state.dismissOperation);
	const close = useRemoteConnectionStore((state) => state.setOpen);
	const [alias, setAlias] = useState(status.alias ?? "");
	const [path, setPath] = useState("");
	const [error, setError] = useState("");
	const [working, setWorking] = useState(false);
	const run = async (operation: () => Promise<void>) => {
		setError("");
		setWorking(true);
		try {
			await operation();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setWorking(false);
		}
	};
	const busy = working || status.state === "connecting";
	return createPortal(
		<div
			className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20"
			role="dialog"
			aria-modal
			aria-label={t("remote.title")}
		>
			<div className="w-[480px] max-w-[calc(100vw-32px)] rounded-xl bg-surface p-5 shadow-dialog">
				<div className="flex items-center justify-between">
					<h2 className="text-ui-14 font-semibold text-ink">{t("remote.title")}</h2>
					<button
						type="button"
						className="rounded-lg px-2 py-1 text-ink-faint hover:bg-hover"
						aria-label={t("common.close")}
						onClick={() => close(false)}
					>
						✕
					</button>
				</div>
				<p className="mt-2 text-ui-12 text-ink-faint">{t("remote.preparedRuntime")}</p>
				<label className="mt-4 block text-ui-12 text-ink-2">
					{t("remote.alias")}
					<input
						className="mt-1 w-full rounded-lg bg-hover px-3 py-2 text-ui-13 text-ink outline-none"
						value={alias}
						onChange={(event) => setAlias(event.target.value)}
						placeholder="company-dev"
						disabled={busy || status.state === "connected"}
					/>
				</label>
				<div className="mt-3 flex items-center justify-between text-ui-12 text-ink-faint">
					<span>{t(`remote.${status.state}`)}</span>
					<div className="flex gap-2">
						<Button onClick={() => void run(disconnect)} disabled={status.state === "disconnected"}>
							{t("remote.disconnect")}
						</Button>
						<Button
							onClick={() => void run(() => connect(alias))}
							disabled={busy || !alias || status.state === "connected"}
						>
							{t("remote.connect")}
						</Button>
					</div>
				</div>
				{status.state === "connected" && (
					<>
						<label className="mt-4 block text-ui-12 text-ink-2">
							{t("remote.projectPath")}
							<input
								className="mt-1 w-full rounded-lg bg-hover px-3 py-2 text-ui-13 text-ink outline-none"
								value={path}
								onChange={(event) => setPath(event.target.value)}
								placeholder="/home/user/project"
							/>
						</label>
						<div className="mt-3 flex justify-end">
							<Button disabled={busy || !path} onClick={() => void run(() => openProject(path))}>
								{t("remote.openProject")}
							</Button>
						</div>
					</>
				)}
				{(status.operations?.length ?? 0) > 0 && (
					<div className="mt-4 space-y-2 text-ui-12 text-ink-2">
						<p>{t("remote.unknownHint")}</p>
						{status.operations?.map((operation) => (
							<div
								key={operation.id}
								className="flex items-center justify-between gap-2 rounded-lg bg-hover px-3 py-2"
							>
								<span>
									{new Date(operation.createdAt).toLocaleTimeString()} ·{" "}
									{t(`remote.receipt.${operation.receipt?.state ?? "unknown"}`)}
								</span>
								<div className="flex shrink-0 gap-1">
									<Button
										disabled={busy || status.state !== "connected"}
										onClick={() => void run(() => checkOperation(operation.id))}
									>
										{t("remote.check")}
									</Button>
									<Button onClick={() => void run(() => dismissOperation(operation.id))}>
										{t("remote.checked")}
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
				{(error || status.error) && (
					<p className="mt-3 break-words text-ui-12 text-err">{error || status.error}</p>
				)}
			</div>
		</div>,
		document.body,
	);
}
