import type { StorageStartupAction, StorageStartupState } from "@percho/shared";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useT } from "./i18n";
import "./styles/globals.css";

function StorageStartup() {
	const t = useT();
	const [state, setState] = useState<StorageStartupState | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let received = false;
		const off = window.pi.onStorageStartup((value) => {
			received = true;
			setState(value);
		});
		void window.pi
			.storageStartupGet()
			.then((value) => {
				if (!received) setState(value);
			})
			.catch((e) => setError(String(e)));
		return off;
	}, []);
	const act = (action: StorageStartupAction) => {
		setError("");
		void window.pi.storageStartupAct({ action }).catch((e) => setError(String(e)));
	};
	const button = (action: StorageStartupAction, label: string) => (
		<button
			type="button"
			className="rounded-lg px-3 py-2 text-ui-13 text-ink-2 hover:bg-hover disabled:opacity-40"
			onClick={() => act(action)}
		>
			{label}
		</button>
	);
	const busy = !state || ["inspecting", "copying", "preferences", "ready"].includes(state.phase);
	return (
		<main className="mx-auto flex h-screen max-w-[640px] flex-col overflow-y-auto gap-4 p-8 text-ui-13 text-ink-2">
			<h1 className="text-ui-18 font-medium">{t("storageStartup.title")}</h1>
			<p>{t(`storageStartup.${state?.phase ?? "inspecting"}`)}</p>
			{busy && (
				<div
					role="progressbar"
					aria-label={t(`storageStartup.${state?.phase ?? "inspecting"}`)}
					className="h-1.5 shrink-0 overflow-hidden rounded-full bg-hover"
				>
					<div className="storage-startup-progress h-full w-1/3 rounded-full bg-ink" />
				</div>
			)}
			{state?.target && (
				<dl className="space-y-2 text-ui-12">
					<dt className="text-ink-faint">{t("storageStartup.target")}</dt>
					<dd className="break-all font-mono">{state.target}</dd>
					{state.source && (
						<>
							<dt className="text-ink-faint">{t("storageStartup.source")}</dt>
							<dd className="break-all font-mono">{state.source}</dd>
						</>
					)}
				</dl>
			)}
			{state && (
				<p className="text-ui-12 text-ink-faint" role="status">
					{t("storageStartup.count", { files: state.files, mb: (state.bytes / 1024 / 1024).toFixed(1) })}
				</p>
			)}
			{state?.phase === "choice" && <p>{t("storageStartup.importHint")}</p>}
			{state?.phase === "existing" && <p>{t("storageStartup.existingHint")}</p>}
			{!!state?.external.length && (
				<div className="max-h-24 overflow-auto text-ui-12">
					<p>{t("storageStartup.external")}</p>
					{state.external.map((path) => (
						<p key={path} className="break-all font-mono">
							{path}
						</p>
					))}
				</div>
			)}
			{(state?.error || error) && (
				<p role="alert" className="max-h-36 overflow-auto whitespace-pre-wrap break-all text-ui-12">
					{state?.error || error}
				</p>
			)}
			<div className="flex flex-wrap justify-end gap-1">
				{state?.phase === "choice" && (
					<>
						{button("copy", t("storageStartup.copy"))}
						{button("empty", t("storageStartup.useEmpty"))}
					</>
				)}
				{state?.phase === "existing" && button("adopt", t("storageStartup.adopt"))}
				{state?.phase === "error" && button("retry", t("storageStartup.retry"))}
				{button(busy ? "cancel" : "exit", t("storageStartup.exit"))}
			</div>
		</main>
	);
}
export function renderStorageStartup() {
	document.documentElement.dataset.storageStartup = "true";
	document.documentElement.dataset.appReady = "true";
	document.getElementById("splash")?.remove();
	const root = document.getElementById("root");
	if (!root) throw new Error("Missing startup root");
	createRoot(root).render(<StorageStartup />);
}
