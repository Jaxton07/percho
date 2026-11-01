import type { SessionMediaJob, SessionMeta } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useT } from "../../i18n";
import { useSessionMediaMaintenanceStore } from "../../stores/session-media-maintenance";
import { ConfirmDialog } from "../ui/ConfirmDialog";

const bytes = (value: number) => `${(value / (1024 * 1024)).toFixed(2)} MiB`;
const active = (job: SessionMediaJob) => ["queued", "running", "cancelling"].includes(job.status);

function Preview({
	session,
	onClose,
	onRetry,
}: {
	session: SessionMeta;
	onClose: () => void;
	onRetry: () => void;
}) {
	const t = useT();
	const explicitlyClosed = useRef(false);
	const [job, setJob] = useState<SessionMediaJob | null>(null),
		[error, setError] = useState("");
	useEffect(() => {
		if (!session.sessionFile) return;
		let disposed = false,
			timer: ReturnType<typeof setTimeout> | undefined;
		const api = getExecutionApi(session.sessionId);
		setJob(null);
		setError("");
		const poll = async (current: SessionMediaJob) => {
			if (disposed) {
				if (explicitlyClosed.current && active(current))
					void api.cancelSessionMediaJob({ jobId: current.jobId }).catch(() => {});
				return;
			}
			setJob(current);
			if (!active(current)) return;
			timer = setTimeout(() => {
				void api.getSessionMediaJob({ jobId: current.jobId }).then(poll).catch(fail);
			}, 250);
		};
		const fail = (cause: unknown) => {
			if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
		};
		void api.startSessionMediaPreview({ sessionFile: session.sessionFile }).then(poll).catch(fail);
		return () => {
			disposed = true;
			clearTimeout(timer);
		};
	}, [session.sessionId, session.sessionFile]);
	let description = t("mediaPreview.readOnly");
	if (error || job?.error) description += ` ${t("mediaPreview.failed")}: ${error || job?.error}`;
	else if (job?.status === "cancelled") description += ` ${t("mediaPreview.cancelled")}`;
	else if (job?.result) {
		const result = job.result;
		if (!result.supported) description += ` ${t("mediaPreview.unsupported")}`;
		else if (result.reason === "no-benefit") description += ` ${t("mediaPreview.noBenefit")}`;
		else
			description += ` ${t("mediaPreview.summary", { before: bytes(result.fileBytes), after: bytes(result.projectedFileBytes), count: result.imageCount, unique: result.uniqueImages, backup: bytes(result.backupBytes), peak: bytes(result.additionalPeakBytes) })}`;
		if (result.invalidLines || result.skippedImages)
			description += ` ${t("mediaPreview.preserved", { invalid: result.invalidLines, skipped: result.skippedImages })}`;
	} else
		description += ` ${t("mediaPreview.scanning", { done: bytes(job?.processedBytes ?? 0), total: bytes(job?.totalBytes ?? 0) })}`;
	return (
		<ConfirmDialog
			danger={false}
			title={t("mediaPreview.title")}
			description={description}
			confirmLabel={t("mediaPreview.refresh")}
			cancelLabel={t("common.close")}
			onConfirm={onRetry}
			onCancel={() => {
				explicitlyClosed.current = true;
				if (job && active(job))
					void getExecutionApi(session.sessionId)
						.cancelSessionMediaJob({ jobId: job.jobId })
						.catch(() => {});
				onClose();
			}}
		/>
	);
}

export function SessionMediaMaintenanceDialog() {
	const [attempt, retry] = useState(0);
	const session = useSessionMediaMaintenanceStore((state) => state.session),
		close = useSessionMediaMaintenanceStore((state) => state.close);
	return session ? (
		<Preview
			key={`${session.sessionId}:${session.sessionFile}:${attempt}`}
			session={session}
			onClose={close}
			onRetry={() => retry((n) => n + 1)}
		/>
	) : null;
}
