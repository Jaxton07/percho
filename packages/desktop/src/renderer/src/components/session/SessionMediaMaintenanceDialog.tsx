import type { SessionMediaJob, SessionMediaTransaction, SessionMeta } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useT } from "../../i18n";
import { useSessionMediaMaintenanceStore } from "../../stores/session-media-maintenance";
import { ConfirmDialog } from "../ui/ConfirmDialog";

const bytes = (value: number) => `${(value / (1024 * 1024)).toFixed(2)} MiB`;
const active = (job: SessionMediaJob) => ["queued", "running", "cancelling"].includes(job.status);
const pending = (record: SessionMediaTransaction) =>
	record.phase !== "complete" && record.phase !== "aborted";
type Action = "compact" | "restore" | "resume" | "abandon";

function Maintenance({
	session,
	onClose,
	onRetry,
}: {
	session: SessionMeta;
	onClose: () => void;
	onRetry: () => void;
}) {
	const t = useT(),
		api = getExecutionApi(session.sessionId);
	const explicitlyClosed = useRef(false),
		disposed = useRef(false),
		timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
		generation = useRef(0);
	const [job, setJob] = useState<SessionMediaJob | null>(null),
		[record, setRecord] = useState<SessionMediaTransaction | null>(null),
		[error, setError] = useState("");
	const [initializing, setInitializing] = useState(true);
	const [action, setAction] = useState<Action | null>(null),
		[submitting, setSubmitting] = useState(false);
	const track = useRef<(current: SessionMediaJob, token: number) => void>(() => {});
	track.current = (current, token) => {
		if (disposed.current || token !== generation.current) {
			if (current.kind === "preview" && explicitlyClosed.current && active(current))
				void api.cancelSessionMediaJob({ jobId: current.jobId }).catch(() => {});
			return;
		}
		setJob(current);
		if (current.transaction) setRecord(current.transaction);
		if (active(current))
			timer.current = setTimeout(() => {
				void api
					.getSessionMediaJob({ jobId: current.jobId })
					.then((next) => track.current(next, token))
					.catch((cause) => {
						if (!disposed.current && token === generation.current)
							setError(cause instanceof Error ? cause.message : String(cause));
					});
			}, 250);
	};
	useEffect(() => {
		disposed.current = false;
		const token = ++generation.current;
		const file = session.sessionFile;
		if (!file) return;
		const fail = (cause: unknown) => {
			if (!disposed.current && token === generation.current)
				setError(cause instanceof Error ? cause.message : String(cause));
		};
		void api
			.getSessionMediaMaintenance({ sessionFile: file })
			.then(async (current) => {
				if (disposed.current || token !== generation.current) return;
				setRecord(current);
				if (current && pending(current)) {
					track.current(await api.getSessionMediaJob({ jobId: current.operationId }), token);
					return;
				}
				track.current(await api.startSessionMediaPreview({ sessionFile: file }), token);
			})
			.catch(fail)
			.finally(() => {
				if (!disposed.current && token === generation.current) setInitializing(false);
			});
		return () => {
			disposed.current = true;
			clearTimeout(timer.current);
		};
	}, [api, session.sessionFile]);

	const execute = async (selected: Action) => {
		setAction(null);
		setSubmitting(true);
		setError("");
		clearTimeout(timer.current);
		const token = ++generation.current;
		const requestId = crypto.randomUUID();
		try {
			let current: SessionMediaJob;
			if (selected === "compact") {
				if (!job?.result?.supported || job.result.reason || !session.sessionFile)
					throw new Error(t("mediaMaintenance.noPreview"));
				current = await api.startSessionMediaCompaction({
					requestId,
					sessionFile: session.sessionFile,
					expectedHash: job.result.sourceHash,
					confirmed: true,
				});
			} else {
				if (!record) throw new Error(t("mediaMaintenance.noRecord"));
				if (selected === "restore")
					current = await api.startSessionMediaRestore({
						requestId,
						compactionRequestId: record.requestId,
						confirmed: true,
					});
				else if (selected === "resume")
					current = await api.resumeSessionMediaJob({ requestId: record.requestId, confirmed: true });
				else current = await api.abandonSessionMediaJob({ requestId: record.requestId, confirmed: true });
			}
			track.current(current, token);
		} catch (cause) {
			if (!disposed.current) setError(cause instanceof Error ? cause.message : String(cause));
			// 启动回应丢失也先查既有requestId，不用新ID重复执行。
			try {
				const known = await api.getSessionMediaTransaction({
					requestId:
						selected === "resume" || selected === "abandon" ? (record?.requestId ?? requestId) : requestId,
				});
				if (known && !disposed.current) {
					setRecord(known);
					track.current(await api.getSessionMediaJob({ jobId: known.operationId }), token);
				}
			} catch {
				/* 保留错误及原件，下次按文件恢复记录重新查询。 */
			}
		} finally {
			if (!disposed.current) setSubmitting(false);
		}
	};

	const working = initializing || submitting || (!job && !record && !error) || Boolean(job && active(job)),
		hasPending = Boolean(record && pending(record));
	const eligible = Boolean(job?.kind === "preview" && job.result?.supported && !job.result.reason);
	const canRestore = record?.kind === "compact" && record.phase === "complete";
	const primary: Action | null = hasPending ? "resume" : eligible ? "compact" : canRestore ? "restore" : null;
	let description = t("mediaPreview.readOnly");
	if (working && job?.kind !== "preview") description = t("mediaMaintenance.background");
	if (record && (hasPending || job?.kind !== "preview"))
		description = `${t("mediaMaintenance.closedRequired")} ${t(`mediaMaintenance.phase.${record.phase}`)}`;
	if (error || job?.error) description += ` ${t("mediaPreview.failed")}: ${error || job?.error}`;
	else if (job?.kind === "preview" && job.result) {
		const result = job.result;
		if (!result.supported) description += ` ${t("mediaPreview.unsupported")}`;
		else if (result.reason === "no-benefit") description += ` ${t("mediaPreview.noBenefit")}`;
		else
			description += ` ${t("mediaPreview.summary", { before: bytes(result.fileBytes), after: bytes(result.projectedFileBytes), count: result.imageCount, unique: result.uniqueImages, backup: bytes(result.backupBytes), peak: bytes(result.additionalPeakBytes) })}`;
		if (result.invalidLines || result.skippedImages)
			description += ` ${t("mediaPreview.preserved", { invalid: result.invalidLines, skipped: result.skippedImages })}`;
	} else if (job?.status === "cancelled") description += ` ${t("mediaPreview.cancelled")}`;
	else if (working || !record)
		description += ` ${t("mediaPreview.scanning", { done: bytes(job?.processedBytes ?? 0), total: bytes(job?.totalBytes ?? 0) })}`;

	if (action)
		return (
			<ConfirmDialog
				title={t(`mediaMaintenance.action.${action}`)}
				description={t(`mediaMaintenance.confirm.${action}`)}
				confirmLabel={t(`mediaMaintenance.action.${action}`)}
				cancelLabel={t("common.cancel")}
				danger={action === "restore"}
				onConfirm={() => void execute(action)}
				onCancel={() => setAction(null)}
			/>
		);
	return (
		<ConfirmDialog
			title={t("mediaPreview.title")}
			description={description}
			confirmDisabled={working}
			confirmLabel={
				working
					? t("mediaMaintenance.working")
					: primary
						? t(`mediaMaintenance.action.${primary}`)
						: t("mediaPreview.refresh")
			}
			cancelLabel={t("common.close")}
			onConfirm={() => (primary ? setAction(primary) : onRetry())}
			onCancel={() => {
				explicitlyClosed.current = true;
				if (job?.kind === "preview" && active(job))
					void api.cancelSessionMediaJob({ jobId: job.jobId }).catch(() => {});
				onClose();
			}}
		>
			{record?.backup && (
				<div className="mt-3 space-y-2 text-ui-12 text-ink-dim">
					<p>{t("mediaMaintenance.backupKept")}</p>
					<p className="break-all select-text">{record.backup}</p>
					<p>{t("mediaMaintenance.appendSafety")}</p>
				</div>
			)}
			{!working && (
				<div className="mt-3 flex flex-wrap gap-3 text-ui-12">
					{hasPending && (
						<button
							type="button"
							className="text-ink-dim hover:text-ink"
							onClick={() => setAction("abandon")}
						>
							{t("mediaMaintenance.action.abandon")}
						</button>
					)}
					{canRestore && primary !== "restore" && (
						<button
							type="button"
							className="text-ink-dim hover:text-ink"
							onClick={() => setAction("restore")}
						>
							{t("mediaMaintenance.action.restore")}
						</button>
					)}
					{job && job.kind !== "preview" && (
						<button type="button" className="text-ink-dim hover:text-ink" onClick={onRetry}>
							{t("mediaPreview.refresh")}
						</button>
					)}
				</div>
			)}
		</ConfirmDialog>
	);
}

export function SessionMediaMaintenanceDialog() {
	const [attempt, retry] = useState(0);
	const session = useSessionMediaMaintenanceStore((state) => state.session),
		close = useSessionMediaMaintenanceStore((state) => state.close);
	return session ? (
		<Maintenance
			key={`${session.sessionId}:${session.sessionFile}:${attempt}`}
			session={session}
			onClose={close}
			onRetry={() => retry((n) => n + 1)}
		/>
	) : null;
}
