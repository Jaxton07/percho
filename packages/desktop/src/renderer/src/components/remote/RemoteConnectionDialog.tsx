import { environmentEntityRef, sameEnvironment } from "@percho/shared";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { Button } from "../ui/Button";

export function RemoteConnectionDialog() {
	const open = useRemoteConnectionStore((state) => state.open);
	return open ? <RemoteConnectionBody /> : null;
}
function RemoteConnectionBody() {
	const t = useT();
	const addedProjects = useProjectsStore((state) => state.addedProjects);
	const status = useRemoteConnectionStore((state) => state.status);
	const connect = useRemoteConnectionStore((state) => state.connect);
	const preflight = useRemoteConnectionStore((state) => state.preflight);
	const forget = useRemoteConnectionStore((state) => state.forget);
	const [confirmForget, setConfirmForget] = useState(false);
	const stopService = useRemoteConnectionStore((state) => state.stopService);
	const [confirmStop, setConfirmStop] = useState(false);
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
	const busy =
		working || status.state === "connecting" || status.state === "checking" || status.state === "stopping";
	return createPortal(
		<div
			className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20"
			role="dialog"
			aria-modal
			aria-label={t("remote.title")}
		>
			<div className="max-h-[calc(100vh-64px)] overflow-y-auto w-[480px] max-w-[calc(100vw-32px)] rounded-xl bg-surface p-5 shadow-dialog">
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
							disabled={busy || !alias || status.state === "connected"}
							onClick={() => void run(() => preflight(alias))}
						>
							{t("remote.preflight")}
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
					<div className="mt-2 text-ui-12">
						{!confirmStop ? (
							<Button onClick={() => setConfirmStop(true)}>{t("remote.stopService")}</Button>
						) : (
							<>
								<p>{t("remote.stopHint")}</p>
								<Button disabled={busy} onClick={() => void run(stopService)}>
									{t("remote.confirmStop")}
								</Button>
								<Button onClick={() => setConfirmStop(false)}>{t("common.cancel")}</Button>
							</>
						)}
					</div>
				)}
				{status.serviceStopped && <p className="mt-2 text-ui-12 text-ink-2">{t("remote.stopConfirmed")}</p>}
				{status.preflight && (
					<div className="mt-3 break-words rounded-lg bg-hover p-3 text-ui-12 text-ink-2" role="status">
						<p>
							{status.preflight.target.user}@{status.preflight.target.hostname}:{status.preflight.target.port}{" "}
							· UID {status.preflight.uid}
						</p>
						<p>
							{status.preflight.platform} {status.preflight.arch} · glibc {status.preflight.glibc || "—"} ·
							Node {status.preflight.nodeVersion}
						</p>
						<p>{status.preflight.node}</p>
						<p>{status.preflight.agentDir}</p>
						{status.preflight.serviceState && (
							<p>
								{t(`remote.service.${status.preflight.serviceState}`)}{" "}
								{status.preflight.service?.runtimeVersion}
							</p>
						)}
						<p>{t(status.preflight.installed ? "remote.installed" : "remote.notInstalled")}</p>
						{!status.preflight.commands.git && <p>{t("remote.gitMissing")}</p>}
					</div>
				)}
				{status.errorKind && (
					<p className="mt-2 text-ui-12 text-ink-faint">{t(`remote.failure.${status.errorKind}`)}</p>
				)}
				<p className="mt-2 text-ui-12 text-ink-faint">{t("remote.disconnectHint")}</p>
				{status.environment && (
					<div className="mt-2 text-ui-12">
						{!confirmForget ? (
							<Button onClick={() => setConfirmForget(true)}>{t("remote.forget")}</Button>
						) : (
							<>
								<p>{t("remote.forgetHint")}</p>
								<Button onClick={() => void run(forget)}>{t("remote.confirmForget")}</Button>
								<Button onClick={() => setConfirmForget(false)}>{t("common.cancel")}</Button>
							</>
						)}
					</div>
				)}
				{status.state === "connected" && (
					<>
						<label className="mt-4 block text-ui-12 text-ink-2">
							{t("remote.projectPath")}
							<input
								className="mt-1 w-full rounded-lg bg-hover px-3 py-2 text-ui-13 text-ink outline-none"
								value={path}
								onChange={(event) => setPath(event.target.value)}
								placeholder="/home/user/project"
								list="remote-recent-projects"
							/>
						</label>
						<datalist id="remote-recent-projects">
							{addedProjects
								.filter(
									(cwd) =>
										status.environment &&
										sameEnvironment(environmentEntityRef(cwd).environment, status.environment),
								)
								.map((cwd) => (
									<option key={cwd} value={environmentEntityRef(cwd).id} />
								))}
						</datalist>
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
