import {
	environmentEntityRef,
	type RemoteConnectionRecord,
	type RemoteRecordCommand,
	type RemoteTokenCommand,
	sameEnvironment,
} from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { useLocalSettingsStore } from "../../stores/settings";
import { SettingsIcon } from "../icons/SettingsIcon";
import { ContextMenu } from "../ui/ContextMenu";
import { anchorOfElement, type MenuAnchor } from "../ui/place-menu";
import { Switch } from "../ui/Switch";
import { Tooltip } from "../ui/Tooltip";
import { RemoteAddDialog } from "./RemoteAddDialog";
import { RemoteModal } from "./RemoteModal";
import "./remote.css";

export function RemoteConnectionDialog() {
	const open = useRemoteConnectionStore((state) => state.open);
	useEffect(() => {
		if (open) useLocalSettingsStore.getState().openWith("remote");
	}, [open]);
	return null;
}

type Dialog =
	| { type: "add" }
	| { type: "details" | "project"; record: RemoteConnectionRecord }
	| {
			type: "switch" | "stop" | "remove";
			record: RemoteConnectionRecord;
			command: RemoteRecordCommand;
			currentConnectionId?: string;
	  }
	| { type: "install" | "target"; record: RemoteConnectionRecord; command: RemoteTokenCommand }
	| { type: "operations" }
	| { type: "reset"; token: string };

// A confirmation shown in a previous visit must not reopen on return.
const shownTokens = new Set<string>();

export function RemoteConnectionPanel() {
	const t = useT();
	const store = useRemoteConnectionStore();
	const { status, catalog } = store;
	const addedProjects = useProjectsStore((state) => state.addedProjects);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [working, setWorking] = useState(false);
	const [path, setPath] = useState("");
	const dialogRef = useRef(dialog);
	dialogRef.current = dialog;
	const initialToken = useRef(status.installation?.token ?? status.targetConfirmation?.token);
	const listRef = useRef<HTMLUListElement>(null);
	const target = store.targetEnvironment;
	const busy =
		status.state === "checking" ||
		status.state === "connecting" ||
		status.state === "reconnecting" ||
		status.state === "stopping" ||
		!!status.installation ||
		!!status.targetConfirmation ||
		!!status.phase;
	const current = catalog.records.find((r) => r.connectionId === status.connectionId);
	const visibleTarget =
		target?.kind === "ssh"
			? catalog.records.find((record) => record.connectionId === target.connectionId)?.connectionId
			: undefined;
	useEffect(() => {
		if (!visibleTarget) return;
		const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-connection-id]") ?? [])].find(
			(item) => item.dataset.connectionId === visibleTarget,
		);
		row?.scrollIntoView?.({ block: "nearest" });
	}, [visibleTarget]);
	const recent = [
		...new Set(
			addedProjects
				.filter(
					(item) =>
						status.environment && sameEnvironment(environmentEntityRef(item).environment, status.environment),
				)
				.map((item) => environmentEntityRef(item).id),
		),
	];
	useEffect(() => {
		useRemoteConnectionStore.getState().setOpen(true);
		return () => {
			useRemoteConnectionStore.getState().setOpen(false);
		};
	}, []);
	useEffect(() => {
		const pending = status.installation ?? status.targetConfirmation;
		if (!pending || !current || !store.open) return;
		const key = `${status.epoch}:${status.generation}:${pending.token}`;
		if (shownTokens.has(key)) return;
		shownTokens.add(key);
		if (shownTokens.size > 128) {
			const oldest = shownTokens.values().next().value;
			if (oldest) shownTokens.delete(oldest);
		}
		if (initialToken.current === pending.token) return;
		// Only open while this panel is foreground and no other child is active.
		if (dialogRef.current || document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1)
			return;
		try {
			setDialog({
				type: status.installation ? "install" : "target",
				record: current,
				command: { ...store.capture(current.connectionId), token: pending.token },
			});
		} catch {
			/* state changed before capture */
		}
	}, [
		status.installation,
		status.targetConfirmation,
		status.epoch,
		status.generation,
		current,
		store.open,
		store.capture,
	]);
	useEffect(() => {
		if (!store.open && dialogRef.current?.type === "project") setDialog(null);
	}, [store.open]);
	const run = async (action: () => Promise<void>, close = false) => {
		if (working) return;
		const originalDialog = dialog;
		setWorking(true);
		setError("");
		try {
			await action();
			if (close) setDialog((currentDialog) => (currentDialog === originalDialog ? null : currentDialog));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setWorking(false);
		}
	};
	const start = (action: () => Promise<void>) => {
		setError("");
		void Promise.resolve()
			.then(action)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	};
	const closeDialog = () => {
		if (working && dialog?.type !== "project") return;
		if (dialog?.type === "install" || dialog?.type === "target") {
			const command = dialog.command;
			setDialog(null);
			start(() => store.disconnect(command));
			return;
		}
		if (dialog?.type === "project") {
			store.setOpen(false);
			store.setOpen(true);
		}
		setDialog(null);
		setError("");
	};
	const connect = (record: RemoteConnectionRecord) => {
		setMenu(null);
		setError("");
		if (busy) return;
		if (status.state === "connected" && current && current.connectionId !== record.connectionId) {
			try {
				setDialog({
					type: "switch",
					record,
					command: store.capture(record.connectionId),
					currentConnectionId: current.connectionId,
				});
			} catch (e) {
				setError(String(e));
			}
		} else start(() => store.connect(record.connectionId));
	};
	const confirm = (type: "stop" | "remove", record: RemoteConnectionRecord) => {
		setMenu(null);
		try {
			setDialog({ type, record, command: store.capture(record.connectionId) });
		} catch (e) {
			setError(String(e));
		}
	};
	const pendingDialog = (type: "install" | "target", record: RemoteConnectionRecord) => {
		const pending = type === "install" ? status.installation : status.targetConfirmation;
		if (!pending) return;
		try {
			setDialog({ type, record, command: { ...store.capture(record.connectionId), token: pending.token } });
		} catch (e) {
			setError(String(e));
		}
	};
	const add = async (alias: string) => {
		const before = useRemoteConnectionStore.getState().status;
		const id = await store.add(alias);
		const after = useRemoteConnectionStore.getState().status;
		setDialog(null);
		if (
			before.epoch !== after.epoch ||
			before.generation !== after.generation ||
			before.connectionId !== after.connectionId ||
			before.state !== after.state
		) {
			setNotice(t("remote.ux.savedLater"));
			return;
		}
		const record = useRemoteConnectionStore.getState().catalog.records.find((r) => r.connectionId === id);
		if (record) connect(record);
	};
	const targetMissing =
		target?.kind === "ssh" &&
		!catalog.records.some(
			(r) => r.connectionId === target.connectionId && r.binding?.environmentId === target.environmentId,
		);
	return (
		<section className="remote-panel text-ui-13" aria-label={t("remote.title")}>
			<div className="remote-list-header">
				<h3 className="text-ui-13 font-medium">{t("remote.ux.listTitle")}</h3>
				<button
					type="button"
					className="remote-primary"
					disabled={busy || !!catalog.error}
					onClick={() => {
						setError("");
						setDialog({ type: "add" });
					}}
				>
					{t("remote.ux.add")}
				</button>
			</div>
			{busy && <p className="remote-note">{t("remote.ux.busyHint")}</p>}
			{targetMissing && (
				<p role="alert" className="remote-note">
					{t("remote.unavailableEnvironment")}
				</p>
			)}
			{notice && (
				<p role="status" className="remote-note">
					{notice}
				</p>
			)}
			{error && !dialog && (
				<p role="alert" className="remote-note">
					{error}
				</p>
			)}
			{catalog.error ? (
				<div role="alert" className="remote-empty">
					{catalog.error}
					{catalog.resetToken && (
						<button
							type="button"
							className="remote-button"
							onClick={() => setDialog({ type: "reset", token: catalog.resetToken as string })}
						>
							{t("remote.ux.reset")}
						</button>
					)}
				</div>
			) : !catalog.records.length ? (
				<div className="remote-empty">
					<SettingsIcon name="server" size={27} />
					<strong>{t("remote.ux.empty")}</strong>
					<p>{t("remote.ux.emptyHint")}</p>
				</div>
			) : (
				<ul className="remote-list" ref={listRef}>
					{catalog.records.map((record) => {
						const active = status.connectionId === record.connectionId;
						const connected = active && status.state === "connected";
						const pending = active && busy;
						const failed = active && (status.state === "error" || status.stopUnconfirmed);
						const projectKnown = connected && recent.length > 0;
						const label = active
							? status.installation
								? t("remote.ux.waitInstall")
								: status.targetConfirmation
									? t("remote.ux.waitTarget")
									: status.phase === "installing"
										? t("remote.ux.installing")
										: status.phase === "preparing"
											? t("remote.ux.preparing")
											: t(`remote.${status.state}`)
							: t("remote.disconnected");
						return (
							<li
								className="remote-row"
								key={record.connectionId}
								data-connection-id={record.connectionId}
								aria-current={
									target?.kind === "ssh" && target.connectionId === record.connectionId
										? "location"
										: undefined
								}
							>
								<Switch
									checked={connected || (pending && !status.installation && !status.targetConfirmation)}
									disabled={working || busy}
									aria-label={`${connected ? t("remote.disconnect") : t("remote.connect")} ${record.alias}`}
									onCheckedChange={() =>
										connected
											? start(() => store.disconnect(store.capture(record.connectionId)))
											: connect(record)
									}
								/>
								<div className="remote-host">
									<div className="remote-host-name">
										<SettingsIcon name="globe" size={14} />
										<span className="truncate">{record.alias}</span>
									</div>
									<div role="status" aria-busy={pending || undefined} className="remote-status">
										<span
											className={
												pending && !status.installation && !status.targetConfirmation
													? "remote-spinner"
													: connected
														? "remote-dot remote-dot-ok"
														: "remote-dot"
											}
										/>
										{label}
									</div>
									{failed && status.error && (
										<p className="remote-error-line">
											{status.error}{" "}
											<button type="button" onClick={() => setDialog({ type: "details", record })}>
												{t("remote.ux.details")}
											</button>
										</p>
									)}
								</div>
								<div className="remote-actions">
									{connected && (
										<Tooltip label={t("remote.openProject")} align="end">
											<button
												type="button"
												className="remote-button"
												onClick={() => {
													setPath("");
													setDialog({ type: "project", record });
												}}
											>
												<SettingsIcon name="folder" size={16} />
												{!projectKnown && t("remote.ux.addProject")}
											</button>
										</Tooltip>
									)}
									{active && status.installation && (
										<button
											type="button"
											className="remote-button"
											onClick={() => pendingDialog("install", record)}
										>
											{t("remote.ux.continueInstall")}
										</button>
									)}
									{active && status.targetConfirmation && (
										<button
											type="button"
											className="remote-button"
											onClick={() => pendingDialog("target", record)}
										>
											{t("remote.ux.continueTarget")}
										</button>
									)}
									{pending && status.state !== "stopping" && (
										<button
											type="button"
											className="remote-button"
											disabled={working}
											onClick={() => start(() => store.disconnect(store.capture(record.connectionId)))}
										>
											{t("common.cancel")}
										</button>
									)}
									{failed && !busy && (
										<button type="button" className="remote-button" onClick={() => connect(record)}>
											{t("remote.ux.retry")}
										</button>
									)}
									{!pending && (
										<Tooltip label={t("remote.ux.more")} align="end">
											<button
												type="button"
												className="remote-icon"
												aria-label={`${t("remote.ux.more")} ${record.alias}`}
												aria-expanded={menu?.id === record.connectionId}
												onClick={(event) =>
													setMenu(
														menu?.id === record.connectionId
															? null
															: { id: record.connectionId, anchor: anchorOfElement(event.currentTarget) },
													)
												}
											>
												<SettingsIcon name="more" />
											</button>
										</Tooltip>
									)}
								</div>
								{menu?.id === record.connectionId && (
									<ContextMenu
										anchor={menu.anchor}
										onClose={() => setMenu(null)}
										items={[
											{
												key: "details",
												label: t("remote.ux.details"),
												onSelect: () => setDialog({ type: "details", record }),
											},
											...(connected
												? [
														{
															key: "reconnect",
															label: t("remote.ux.reconnect"),
															onSelect: () =>
																start(() => store.reconnect(store.capture(record.connectionId))),
														},
														{
															key: "disconnect",
															label: t("remote.disconnect"),
															onSelect: () =>
																start(() => store.disconnect(store.capture(record.connectionId))),
														},
														{
															key: "stop",
															label: t("remote.stopService"),
															onSelect: () => confirm("stop", record),
														},
													]
												: [
														{
															key: "connect",
															label: t("remote.connect"),
															disabled: busy,
															onSelect: () => connect(record),
														},
													]),
											{
												key: "remove",
												label: t("remote.forget"),
												disabled: busy,
												separatorBefore: true,
												onSelect: () => confirm("remove", record),
											},
										]}
									/>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{((status.operations?.length ?? 0) > 0 || status.operationsTruncated) && (
				<button
					type="button"
					className="remote-button mt-4"
					onClick={() => setDialog({ type: "operations" })}
				>
					{t("remote.ux.operations")}
				</button>
			)}
			{dialog?.type === "add" && (
				<RemoteAddDialog
					aliasesSaved={catalog.records.map((r) => r.alias)}
					busy={busy}
					slotKey={JSON.stringify([status.epoch, status.generation, status.connectionId, status.state])}
					onClose={closeDialog}
					onSave={add}
				/>
			)}
			{dialog && dialog.type !== "add" && (
				<RemoteModal
					title={t(
						dialog.type === "details"
							? "remote.ux.details"
							: dialog.type === "project"
								? "remote.ux.addProject"
								: dialog.type === "switch"
									? "remote.ux.switchTitle"
									: dialog.type === "stop"
										? "remote.stopService"
										: dialog.type === "remove"
											? "remote.forget"
											: dialog.type === "install"
												? "remote.ux.installTitle"
												: dialog.type === "target"
													? "remote.ux.targetTitle"
													: dialog.type === "reset"
														? "remote.ux.reset"
														: "remote.ux.operations",
					)}
					onClose={closeDialog}
					locked={working && dialog.type !== "project"}
					footer={
						<>
							<button
								type="button"
								data-initial-focus={
									dialog.type === "stop" ||
									dialog.type === "remove" ||
									dialog.type === "switch" ||
									dialog.type === "reset" ||
									undefined
								}
								className="remote-button"
								onClick={closeDialog}
							>
								{t("common.cancel")}
							</button>
							{dialog.type !== "details" && dialog.type !== "operations" && (
								<button
									type="button"
									className="remote-primary"
									disabled={working || (dialog.type === "project" && !path.trim())}
									onClick={() => {
										if (dialog.type === "switch" && dialog.currentConnectionId) {
											setDialog(null);
											start(() =>
												store.switchConnection({
													...dialog.command,
													currentConnectionId: dialog.currentConnectionId as string,
												}),
											);
										} else if (dialog.type === "stop") {
											setDialog(null);
											start(() => store.stopService(dialog.command));
										} else if (dialog.type === "remove")
											void run(
												() => store.forget({ ...dialog.command, recordRevision: dialog.record.revision }),
												true,
											);
										else if (dialog.type === "install") {
											setDialog(null);
											start(() => store.install(dialog.command));
										} else if (dialog.type === "target") {
											setDialog(null);
											start(() => store.confirmTarget(dialog.command));
										} else if (dialog.type === "reset")
											void run(() => store.resetCatalog(dialog.token), true);
										else if (dialog.type === "project") void run(() => store.openProject(path), true);
									}}
								>
									{working
										? t("remote.ux.working")
										: t(
												dialog.type === "switch"
													? "remote.ux.switchAction"
													: dialog.type === "stop"
														? "remote.confirmStop"
														: dialog.type === "remove"
															? "remote.confirmForget"
															: dialog.type === "install"
																? "remote.confirmInstall"
																: dialog.type === "target"
																	? "remote.ux.confirmTarget"
																	: dialog.type === "reset"
																		? "remote.ux.reset"
																		: "remote.ux.addProject",
											)}
								</button>
							)}
						</>
					}
				>
					{dialog.type === "details" && (
						<>
							<p className="remote-detail">
								<span>{t("remote.alias")}</span>
								<b>{dialog.record.alias}</b>
							</p>
							<p className="remote-detail">
								<span>{t("remote.ux.status")}</span>
								<b>
									{status.connectionId === dialog.record.connectionId
										? t(`remote.${status.state}`)
										: t("remote.disconnected")}
								</b>
							</p>
							<p className="remote-note">
								{status.connectionId === dialog.record.connectionId && status.state === "connected"
									? t("remote.ux.currentInfo")
									: t("remote.ux.lastChecked")}
							</p>
							<p className="remote-detail">
								<span>{t("remote.ux.address")}</span>
								<b>
									{dialog.record.binding?.target
										? `${dialog.record.binding.target.user}@${dialog.record.binding.target.hostname}:${dialog.record.binding.target.port}`
										: t("remote.ux.unknown")}
								</b>
							</p>
							<p className="remote-detail">
								<span>{t("remote.ux.service")}</span>
								<b>{dialog.record.binding?.releaseId ?? t("remote.ux.unknown")}</b>
							</p>
							{status.connectionId === dialog.record.connectionId && status.preflight && (
								<details className="remote-note">
									<summary>{t("remote.ux.technical")}</summary>
									<p className="break-all">
										{status.preflight.platform} {status.preflight.arch} · glibc {status.preflight.glibc} ·
										Node {status.preflight.nodeVersion} · UID {status.preflight.uid}
										<br />
										{status.preflight.node}
										<br />
										{status.preflight.agentDir}
									</p>
								</details>
							)}
							<div className="mt-4 flex flex-wrap gap-2">
								<button
									type="button"
									className="remote-button"
									disabled={busy || status.state === "connected" || working}
									onClick={() => {
										const command = store.capture(dialog.record.connectionId);
										setDialog(null);
										start(() => store.preflight(command));
									}}
								>
									{t("remote.preflight")}
								</button>
								<button
									type="button"
									className="remote-button"
									disabled={
										busy ||
										status.state === "connected" ||
										working ||
										(!!status.stopUnconfirmed && status.connectionId === dialog.record.connectionId)
									}
									onClick={() => {
										const command = store.capture(dialog.record.connectionId);
										setDialog(null);
										start(() => store.prepareInstall(command));
									}}
								>
									{t("remote.prepareUpdate")}
								</button>
								<button
									type="button"
									className="remote-button"
									disabled={working}
									onClick={() =>
										void run(async () => {
											const record = dialog.record;
											await navigator.clipboard.writeText(
												JSON.stringify(
													{
														alias: record.alias,
														target: record.binding?.target,
														service: record.binding?.releaseId,
														state:
															status.connectionId === record.connectionId ? status.state : "disconnected",
														errorKind:
															status.connectionId === record.connectionId ? status.errorKind : undefined,
													},
													null,
													2,
												),
											);
										})
									}
								>
									{t("remote.ux.copyDiagnostics")}
								</button>
							</div>
							{status.state === "connected" && (
								<p className="remote-note">{t("remote.ux.disconnectFirst")}</p>
							)}
							{status.connectionId === dialog.record.connectionId && status.error && (
								<details className="remote-note">
									<summary>{t("remote.ux.technical")}</summary>
									<p className="break-all">{status.error}</p>
								</details>
							)}
						</>
					)}
					{dialog.type === "switch" && (
						<p className="remote-intro">
							{t("remote.ux.switchHint")} {current?.alias} → {dialog.record.alias}
						</p>
					)}
					{dialog.type === "stop" && (
						<p className="remote-intro">
							{dialog.record.alias}: {t("remote.stopHint")}
						</p>
					)}
					{dialog.type === "remove" && (
						<p className="remote-intro">
							{dialog.record.alias}: {t("remote.forgetHint")} {t("remote.ux.removeHint")}
						</p>
					)}
					{dialog.type === "reset" && <p className="remote-intro">{t("remote.ux.resetHint")}</p>}
					{dialog.type === "install" && (
						<>
							<p className="remote-intro">{dialog.record.alias}</p>
							{status.installation && (
								<>
									<p>
										{status.installation.releaseId} · {Math.ceil(status.installation.bytes / 1048576)} MB
									</p>
									<p className="remote-note">{t("remote.ux.installHint")}</p>
									<details className="remote-note">
										<summary>{t("remote.ux.installDirectory")}</summary>
										<p className="break-all">{status.installation.directory}</p>
									</details>
								</>
							)}
						</>
					)}
					{dialog.type === "target" && (
						<>
							<p className="remote-intro">{t("remote.ux.targetHint")}</p>
							<p className="break-all">
								{status.targetConfirmation &&
									`${status.targetConfirmation.target.user}@${status.targetConfirmation.target.hostname}:${status.targetConfirmation.target.port}`}
							</p>
						</>
					)}
					{dialog.type === "project" && (
						<>
							<p className="remote-intro">{dialog.record.alias}</p>
							<label htmlFor="remote-project-path" className="text-ui-12">
								{t("remote.projectPath")}
							</label>
							<input
								data-initial-focus
								id="remote-project-path"
								className="remote-input"
								value={path}
								onChange={(e) => setPath(e.target.value)}
								placeholder="/home/user/project"
							/>
							<p className="remote-note">{t("remote.ux.absolutePath")}</p>
							{recent.map((item) => (
								<button className="remote-recent" type="button" key={item} onClick={() => setPath(item)}>
									{item}
								</button>
							))}
						</>
					)}
					{dialog.type === "operations" && (
						<>
							<p className="remote-note">{t("remote.unknownHint")}</p>
							{status.operationsTruncated && (
								<p role="alert" className="remote-note">
									{t("remote.ux.truncated")}
								</p>
							)}
							{status.operations?.map((operation) => (
								<div key={operation.id} className="remote-detail">
									<span>
										{new Date(operation.createdAt).toLocaleString()} ·{" "}
										{t(`remote.receipt.${operation.receipt?.state ?? "unknown"}`)}
										<br />
										{operation.environment.kind === "ssh"
											? (catalog.records.find(
													(record) =>
														operation.environment.kind === "ssh" &&
														record.connectionId === operation.environment.connectionId &&
														record.binding?.environmentId === operation.environment.environmentId,
												)?.alias ?? t("remote.unavailableEnvironment"))
											: t("remote.unavailableEnvironment")}
										<br />
										{operation.operation.instanceId}
									</span>
									<div>
										<button
											type="button"
											className="remote-button"
											disabled={
												working ||
												status.state !== "connected" ||
												!status.environment ||
												!sameEnvironment(operation.environment, status.environment)
											}
											onClick={() => void run(() => store.checkOperation(operation.id))}
										>
											{t("remote.check")}
										</button>
										<button
											type="button"
											className="remote-button"
											disabled={working}
											onClick={() => void run(() => store.dismissOperation(operation.id))}
										>
											{t("remote.checked")}
										</button>
									</div>
								</div>
							))}
						</>
					)}
					{working && (
						<p role="status" className="remote-note">
							<span className="remote-spinner" /> {t("remote.ux.working")}
						</p>
					)}
					{error && (
						<p role="alert" className="remote-note">
							{error}
						</p>
					)}
				</RemoteModal>
			)}
		</section>
	);
}
