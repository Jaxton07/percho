import { environmentEntityRef, sameEnvironment } from "@percho/shared";
import { type ComponentType, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteConnectionStore } from "../../stores/remote-connection";
import { useLocalSettingsStore } from "../../stores/settings";
import { ChevronDownIcon, FolderOpenIcon, LoginIcon, PowerIcon, RefreshIcon, UnplugIcon } from "../icons";
import { Button } from "../ui/Button";
import { SelectionMenu } from "../ui/SelectionMenu";
import { Tooltip } from "../ui/Tooltip";

/** Existing project/error entry points now route to the settings category. */
export function RemoteConnectionDialog() {
	const open = useRemoteConnectionStore((state) => state.open);
	useEffect(() => {
		if (open) useLocalSettingsStore.getState().openWith("remote");
	}, [open]);
	return null;
}

function ConnectionAction({
	label,
	icon: Icon,
	disabled,
	onClick,
}: {
	label: string;
	icon: ComponentType<{ size?: number }>;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Tooltip label={label} align="end">
			<button
				type="button"
				aria-label={label}
				disabled={disabled}
				onClick={onClick}
				className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-dim transition-colors hover:bg-hover hover:text-ink disabled:opacity-35 disabled:cursor-default"
			>
				<Icon size={16} />
			</button>
		</Tooltip>
	);
}

export function RemoteConnectionPanel() {
	useEffect(() => {
		useRemoteConnectionStore.getState().setOpen(true);
		const off = useRemoteConnectionStore.subscribe((state, previous) => {
			if (previous.open && !state.open) useLocalSettingsStore.getState().setOpen(false);
		});
		return () => {
			off();
			if (useRemoteConnectionStore.getState().open) useRemoteConnectionStore.getState().setOpen(false);
		};
	}, []);
	const t = useT();
	const addedProjects = useProjectsStore((state) => state.addedProjects);
	const status = useRemoteConnectionStore((state) => state.status);
	const install = useRemoteConnectionStore((state) => state.install);
	const prepareInstall = useRemoteConnectionStore((state) => state.prepareInstall);
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
	const projectField = useRef<HTMLDivElement>(null);
	const [recentAnchor, setRecentAnchor] = useState<HTMLElement | null>(null);
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
	const installation = status.installation;
	const busy =
		working || status.state === "connecting" || status.state === "checking" || status.state === "stopping";
	const recentProjects = [
		...new Set(
			addedProjects
				.filter(
					(cwd) =>
						status.environment && sameEnvironment(environmentEntityRef(cwd).environment, status.environment),
				)
				.map((cwd) => environmentEntityRef(cwd).id),
		),
	];
	return (
		<section aria-label={t("remote.title")} className="pb-4">
			<h3 className="text-ui-14 font-medium text-ink">{t("remote.title")}</h3>
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
			<div className="mt-3 flex items-center justify-between gap-3 text-ui-12 text-ink-dim">
				<span className="flex items-center gap-2" role="status">
					<span
						aria-hidden
						className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.state === "connected" ? "bg-ok" : "bg-ink-faint"}`}
					/>
					{t(`remote.${status.state}`)}
				</span>
				<div className="flex shrink-0 items-center gap-1">
					<ConnectionAction
						label={t("remote.disconnect")}
						icon={UnplugIcon}
						onClick={() => void run(disconnect)}
						disabled={status.state === "disconnected" || status.state === "stopping"}
					/>
					<ConnectionAction
						label={t("remote.preflight")}
						icon={RefreshIcon}
						disabled={busy || !alias || status.state === "connected"}
						onClick={() => void run(() => preflight(alias))}
					/>
					<ConnectionAction
						label={t("remote.connect")}
						icon={LoginIcon}
						disabled={busy || !alias || status.state === "connected"}
						onClick={() => void run(() => connect(alias))}
					/>
					<ConnectionAction
						label={t("remote.stopService")}
						icon={PowerIcon}
						disabled={busy || status.state !== "connected"}
						onClick={() => setConfirmStop(true)}
					/>
				</div>
			</div>
			{installation && status.alias === alias && (
				<div className="mt-3 rounded-lg bg-hover p-3 text-ui-12 text-ink-2">
					<p>{t("remote.installHint")}</p>
					<p className="mt-2 break-all">
						{installation.releaseId} · {Math.ceil(installation.bytes / 1048576)} MB
						<br />
						{installation.directory}
					</p>
					<div className="mt-3 flex gap-2">
						<Button disabled={busy} onClick={() => void run(() => install(installation.token))}>
							{t("remote.confirmInstall")}
						</Button>
						<Button disabled={busy} onClick={() => void run(disconnect)}>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			)}
			{status.preflight?.installed && status.state === "disconnected" && !status.installation && (
				<Button disabled={busy || !alias} onClick={() => void run(() => prepareInstall(alias))}>
					{t("remote.prepareUpdate")}
				</Button>
			)}
			{status.state === "connected" && confirmStop && (
				<div className="mt-3 rounded-lg bg-hover p-3 text-ui-12 text-ink-2">
					<p>{t("remote.stopHint")}</p>
					<div className="mt-2 flex justify-end gap-1">
						<Button onClick={() => setConfirmStop(false)}>{t("common.cancel")}</Button>
						<Button
							disabled={busy}
							onClick={() =>
								void run(async () => {
									await stopService();
									setConfirmStop(false);
								})
							}
						>
							{t("remote.confirmStop")}
						</Button>
					</div>
				</div>
			)}
			{status.serviceStopped && <p className="mt-2 text-ui-12 text-ink-2">{t("remote.stopConfirmed")}</p>}
			{status.preflight && (
				<div className="mt-3 rounded-lg bg-hover p-3 text-ui-12 text-ink-2">
					<p>
						{status.preflight.target.user}@{status.preflight.target.hostname}:{status.preflight.target.port}
					</p>
					<p className="mt-1 text-ui-115 text-ink-dim">
						{status.preflight.platform} {status.preflight.arch} · glibc {status.preflight.glibc || "—"} · Node{" "}
						{status.preflight.nodeVersion} · UID {status.preflight.uid}
					</p>
					<dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-ui-115">
						<dt className="text-ink-faint">{t("remote.nodePath")}</dt>
						<dd className="break-all font-mono text-ink-dim">{status.preflight.node}</dd>
						<dt className="text-ink-faint">{t("remote.dataDirectory")}</dt>
						<dd className="break-all font-mono text-ink-dim">{status.preflight.agentDir}</dd>
						<dt className="text-ink-faint">{t("remote.runtimePackage")}</dt>
						<dd className="text-ink-dim">
							{t(status.preflight.installed ? "remote.installed" : "remote.notInstalled")}
						</dd>
					</dl>
					{status.state !== "connected" && status.preflight.serviceState && (
						<p className="mt-2 text-ui-115 text-ink-faint">
							{t(`remote.service.${status.preflight.serviceState}`)}{" "}
							{status.preflight.service?.runtimeVersion}
						</p>
					)}
					{!status.preflight.commands.git && (
						<p className="mt-2 text-ui-115 text-ink-faint">{t("remote.gitMissing")}</p>
					)}
				</div>
			)}
			{status.errorKind && (
				<p className="mt-2 text-ui-12 text-ink-faint">{t(`remote.failure.${status.errorKind}`)}</p>
			)}
			<p className="mt-2 text-ui-12 text-ink-faint">{t("remote.disconnectHint")}</p>
			{status.state === "connected" && (
				<div className="mt-5">
					<label htmlFor="remote-project-path" className="block text-ui-12 text-ink-2">
						{t("remote.projectPath")}
					</label>
					<div className="mt-1 flex items-center gap-2">
						<div ref={projectField} className="flex min-w-0 flex-1 items-center rounded-lg bg-hover px-2">
							<input
								id="remote-project-path"
								className="min-w-0 flex-1 bg-transparent px-1 py-2 text-ui-13 text-ink outline-none"
								value={path}
								onChange={(event) => setPath(event.target.value)}
								placeholder="/home/user/project"
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "ArrowDown" && recentProjects.length && !busy) {
										event.preventDefault();
										setRecentAnchor(projectField.current?.querySelector("button") ?? null);
									}
									if (event.key === "Enter" && path && !busy) void run(() => openProject(path));
								}}
							/>

							<button
								type="button"
								aria-label={t("remote.recentProjects")}
								aria-haspopup="listbox"
								aria-expanded={!!recentAnchor}
								disabled={!recentProjects.length || busy}
								className="flex h-8 w-7 items-center justify-center rounded-lg text-ink-faint hover:text-ink disabled:opacity-35"
								onClick={(event) => setRecentAnchor(recentAnchor ? null : event.currentTarget)}
							>
								<ChevronDownIcon size={12} />
							</button>
						</div>
						<ConnectionAction
							label={t("remote.openProject")}
							icon={FolderOpenIcon}
							disabled={busy || !path}
							onClick={() => void run(() => openProject(path))}
						/>
					</div>
					{recentAnchor && (
						<SelectionMenu
							anchor={recentAnchor}
							field={projectField.current ?? undefined}
							label={t("remote.recentProjects")}
							value={path}
							options={recentProjects.map((value) => ({ value, label: value }))}
							onSelect={setPath}
							onClose={() => setRecentAnchor(null)}
						/>
					)}
				</div>
			)}
			{(status.environment || status.errorKind === "identity") && (
				<div className="mt-5 text-ui-12">
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
			{(status.operations?.length ?? 0) > 0 && (
				<div className="mt-4 space-y-2 text-ui-12 text-ink-2">
					<p>{t("remote.unknownHint")}</p>
					{status.operations?.map((operation) => (
						<div
							key={operation.id}
							className="flex items-center justify-between gap-2 rounded-lg bg-hover px-3 py-2"
						>
							<span>
								{(!status.environment || !sameEnvironment(operation.environment, status.environment)) && (
									<>{t("remote.unavailableEnvironment")} · </>
								)}
								{new Date(operation.createdAt).toLocaleTimeString()} ·{" "}
								{t(`remote.receipt.${operation.receipt?.state ?? "unknown"}`)}
							</span>
							<div className="flex shrink-0 gap-1">
								<Button
									disabled={
										busy ||
										status.state !== "connected" ||
										!status.environment ||
										!sameEnvironment(operation.environment, status.environment)
									}
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
		</section>
	);
}
