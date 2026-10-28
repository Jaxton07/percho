import type { StorageStartupAction, StorageStartupState } from "@percho/shared";
import { type ComponentType, type ReactNode, useState } from "react";
import { useT } from "../../i18n";
import {
	ArrowLeftIcon,
	ChevronRightIcon,
	CopyIcon,
	ErrorCircleIcon,
	FileTextIcon,
	FolderIcon,
} from "../icons";
import { Button } from "../ui/Button";
import { StartupSheet } from "./StartupSheet";

type Detail = "paths" | "shared" | "error" | "cancel";
export function StorageStartup({
	state,
	error,
	onAction,
}: {
	state: StorageStartupState | null;
	error: string;
	onAction: (action: StorageStartupAction) => void;
}) {
	const t = useT();
	const [selection, setSelection] = useState<"copy" | "empty">("copy");
	const [step, setStep] = useState<"choose" | "review" | "empty">("choose");
	const [detail, setDetail] = useState<Detail | null>(null);
	const phase = error ? "error" : (state?.phase ?? "inspecting");
	const view = phase === "choice" ? step : phase;
	const active = phase === "copying" || phase === "preferences";
	const title = (
		key: "chooseTitle" | "reviewTitle" | "emptyTitle" | "existingTitle" | "progressTitle" | "errorTitle",
		subtitle: string,
		Icon: ComponentType<{ size?: number; className?: string }>,
	) => (
		<>
			<Icon
				size={54}
				className={`startup-emblem mx-auto mb-4 ${phase === "error" ? "text-err" : "text-ink-2"}`}
			/>
			<h1 className="text-ui-19 font-medium tracking-tight text-ink">{t(`storageStartup.${key}`)}</h1>
			<p className="mt-2 text-ui-13 leading-relaxed text-ink-dim">{subtitle}</p>
		</>
	);
	const more = (label: string, value: Detail) => (
		<button
			type="button"
			onClick={() => setDetail(value)}
			className="inline-flex items-center gap-1 py-1 text-ui-115 text-ink-dim hover:text-ink"
		>
			{label}
			<ChevronRightIcon size={11} />
		</button>
	);
	const pathLink = (
		<div className="mt-3 flex flex-wrap justify-center gap-x-5 gap-y-1">
			{more(t("storageStartup.viewPaths"), "paths")}
			{!!state?.external.length &&
				view === "review" &&
				more(t("storageStartup.sharedCount", { count: state.external.length }), "shared")}
		</div>
	);
	const summary = (heading: string, children: ReactNode) => (
		<div className="mt-5 rounded-xl bg-hover/60 px-4 py-3 text-left">
			<p className="text-ui-13 font-medium text-ink-2">{heading}</p>
			<p className="mt-1 text-ui-12 leading-relaxed text-ink-dim">{children}</p>
		</div>
	);
	let content: ReactNode;
	let left: ReactNode = <Button onClick={() => onAction("exit")}>{t("storageStartup.exitSetup")}</Button>;
	let right: ReactNode;
	if (view === "choose") {
		content = (
			<>
				{title("chooseTitle", t("storageStartup.chooseHint"), CopyIcon)}
				<div
					className="mt-6 space-y-1 text-left"
					role="radiogroup"
					aria-label={t("storageStartup.chooseTitle")}
				>
					{(["copy", "empty"] as const).map((value) => (
						<label
							key={value}
							className={`flex min-h-18 cursor-pointer items-center gap-3 rounded-xl px-4 py-3 ${selection === value ? "bg-hover" : "hover:bg-hover/60"}`}
						>
							{value === "copy" ? (
								<FolderIcon size={25} className="shrink-0 text-ink-dim" />
							) : (
								<FileTextIcon size={25} className="shrink-0 text-ink-dim" />
							)}
							<span className="min-w-0 flex-1">
								<span className="block text-ui-13 font-medium text-ink-2">
									{t(value === "copy" ? "storageStartup.copyOption" : "storageStartup.emptyOption")}
								</span>
								<span className="mt-0.5 block text-ui-115 text-ink-dim">
									{t(value === "copy" ? "storageStartup.copyOptionHint" : "storageStartup.emptyOptionHint")}
								</span>
							</span>
							<input
								type="radio"
								name="storage-mode"
								value={value}
								checked={selection === value}
								onChange={() => setSelection(value)}
								className="h-3.5 w-3.5 shrink-0 accent-ink-2"
							/>
						</label>
					))}
				</div>
				<p className="mt-4 text-ui-115 text-ink-faint">{t("storageStartup.sourceRetained")}</p>
			</>
		);
		right = (
			<Button
				className="font-medium text-ink-2"
				onClick={() => setStep(selection === "copy" ? "review" : "empty")}
			>
				{t("storageStartup.continue")}
				<ChevronRightIcon className="ml-1 inline" />
			</Button>
		);
	} else if (view === "review" || view === "empty") {
		const copy = view === "review";
		content = (
			<>
				{title(
					copy ? "reviewTitle" : "emptyTitle",
					t(copy ? "storageStartup.reviewHint" : "storageStartup.emptyHint"),
					copy ? CopyIcon : FileTextIcon,
				)}
				{summary(
					t(copy ? "storageStartup.contents" : "storageStartup.newDirectory"),
					t(copy ? "storageStartup.contentsHint" : "storageStartup.emptySummary"),
				)}
				{copy && state && (
					<p className="mt-2 text-ui-11 tabular-nums text-ink-faint">
						{t("storageStartup.count", {
							files: state.totalFiles ?? state.files,
							mb: ((state.totalBytes ?? state.bytes) / 1048576).toFixed(1),
						})}
					</p>
				)}
				{pathLink}
				{copy && (
					<p className="mt-3 text-ui-115 leading-relaxed text-ink-dim">{t("storageStartup.closeOldApps")}</p>
				)}
			</>
		);
		left = (
			<Button onClick={() => setStep("choose")}>
				<ArrowLeftIcon size={12} className="mr-1 inline" />
				{t("storageStartup.back")}
			</Button>
		);
		right = (
			<Button className="font-medium text-ink-2" onClick={() => onAction(copy ? "copy" : "empty")}>
				{t(copy ? "storageStartup.startCopy" : "storageStartup.emptyOption")}
				<ChevronRightIcon className="ml-1 inline" />
			</Button>
		);
	} else if (view === "existing") {
		content = (
			<>
				{title("existingTitle", t("storageStartup.existingHint"), FolderIcon)}
				{summary(t("storageStartup.adopt"), t("storageStartup.adoptHint"))}
				{pathLink}
			</>
		);
		right = (
			<Button className="font-medium text-ink-2" onClick={() => onAction("adopt")}>
				{t("storageStartup.adopt")}
				<ChevronRightIcon className="ml-1 inline" />
			</Button>
		);
	} else if (view === "error") {
		content = (
			<>
				{title("errorTitle", t("storageStartup.errorHint"), ErrorCircleIcon)}
				<div className="mt-4">{more(t("storageStartup.errorDetails"), "error")}</div>
			</>
		);
		if (state?.retryable !== false)
			right = (
				<Button
					className="font-medium text-ink-2"
					onClick={() => {
						setStep("choose");
						onAction("retry");
					}}
				>
					{t("storageStartup.retry")}
				</Button>
			);
	} else {
		const work = state?.workPhase;
		const progress =
			active && phase === "copying" && work === "copy" && state && (state.totalBytes ?? 0) > 0
				? Math.min(100, Math.floor((state.bytes / (state.totalBytes as number)) * 100))
				: undefined;
		const message =
			phase === "copying"
				? t(
						work === "copy"
							? "storageStartup.copying"
							: work === "verify"
								? "storageStartup.verifying"
								: work === "publish"
									? "storageStartup.publishing"
									: "storageStartup.scanning",
					)
				: t(phase === "preferences" ? "storageStartup.preferences" : "storageStartup.ready");
		content = (
			<>
				{title("progressTitle", t("storageStartup.keepOpen"), CopyIcon)}
				<div className="mt-7">
					<div
						className="startup-track mx-auto"
						role="progressbar"
						aria-label={message}
						aria-valuenow={progress}
						aria-valuemin={progress === undefined ? undefined : 0}
						aria-valuemax={progress === undefined ? undefined : 100}
					>
						<div
							className={progress === undefined ? "startup-track-unknown" : "startup-track-fill"}
							style={progress === undefined ? undefined : { transform: `scaleX(${progress / 100})` }}
						/>
					</div>
					<p className="mt-3 text-ui-12 text-ink-dim" role="status">
						{message}
					</p>
					{state && active && (
						<p className="mt-1 text-ui-11 tabular-nums text-ink-faint">
							{progress === undefined
								? t("storageStartup.count", { files: state.files, mb: (state.bytes / 1048576).toFixed(1) })
								: t("storageStartup.copyProgress", {
										mb: (state.bytes / 1048576).toFixed(1),
										total: ((state.totalBytes ?? 0) / 1048576).toFixed(1),
										percent: progress,
									})}
						</p>
					)}
				</div>
				{pathLink}
			</>
		);
		left = <Button onClick={() => setDetail("cancel")}>{t("storageStartup.exit")}</Button>;
	}
	return (
		<>
			<main className="startup-layout bg-canvas text-ink-2" data-phase={phase}>
				<header className="startup-header relative flex items-center justify-center text-ui-11 text-ink-faint">
					<span>
						{phase === "choice" ? t("storageStartup.step", { step: view === "choose" ? 1 : 2 }) : ""}
					</span>
					<span className="absolute right-6">Percho</span>
				</header>
				<div className="startup-content">
					<div className="startup-page text-center">{content}</div>
				</div>
				<footer className="startup-footer flex shrink-0 items-center justify-between px-6">
					<div>{left}</div>
					<div>{right}</div>
				</footer>
			</main>
			{detail && (
				<StartupSheet
					title={t(
						detail === "paths"
							? "storageStartup.directoryDetails"
							: detail === "shared"
								? "storageStartup.external"
								: detail === "cancel"
									? "storageStartup.cancelTitle"
									: "storageStartup.errorDetails",
					)}
					closeLabel={t(detail === "cancel" ? "storageStartup.keepWaiting" : "storageStartup.done")}
					onClose={() => setDetail(null)}
					action={
						detail === "cancel" ? (
							<Button onClick={() => onAction("cancel")}>{t("storageStartup.exit")}</Button>
						) : undefined
					}
				>
					{detail === "cancel" ? (
						<p>{t("storageStartup.cancelHint")}</p>
					) : detail === "error" ? (
						<pre className="whitespace-pre-wrap break-words font-mono text-ui-115">
							{error || state?.error}
						</pre>
					) : detail === "shared" ? (
						<>
							<p className="mb-3">{t("storageStartup.externalHint")}</p>
							<ul className="space-y-3 font-mono text-ui-115">
								{state?.external.map((path) => (
									<li key={path} className="break-all">
										{path}
									</li>
								))}
							</ul>
						</>
					) : (
						<dl className="space-y-4">
							{state?.source && (view === "review" || phase === "copying") && (
								<div>
									<dt className="mb-1 text-ink-faint">{t("storageStartup.source")}</dt>
									<dd className="break-all font-mono text-ui-115">{state.source}</dd>
								</div>
							)}
							<div>
								<dt className="mb-1 text-ink-faint">{t("storageStartup.target")}</dt>
								<dd className="break-all font-mono text-ui-115">{state?.target}</dd>
							</div>
						</dl>
					)}
				</StartupSheet>
			)}
		</>
	);
}
