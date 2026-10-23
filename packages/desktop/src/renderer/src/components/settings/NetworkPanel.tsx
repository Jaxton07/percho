import type { NetworkSettings, NetworkSettingsError, NetworkSettingsStatus } from "@percho/shared";
import { useEffect, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { pushToast } from "../../stores/toasts";
import { CloseIcon, SearchIcon, TodoSpinnerIcon } from "../icons";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";

const MODES = ["environment", "manual", "direct"] as const;
const INPUT_CLASS =
	"min-w-0 w-full rounded-lg border border-border bg-surface px-3 py-2 text-ui-13 text-ink outline-none focus:border-border-strong";

export function NetworkPanel() {
	const t = useT();
	const [status, setStatus] = useState<NetworkSettingsStatus | null>(null);
	const [draft, setDraft] = useState<NetworkSettings | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<
		NetworkSettingsError | "loadFailed" | "saveFailed" | "passwordUnavailable" | null
	>(null);
	const [testing, setTesting] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [saved, setSaved] = useState(false);
	const [reload, setReload] = useState(true);

	useEffect(() => {
		if (!reload) return;
		let cancelled = false;
		setError(null);
		void getPi()
			.loadNetworkSettings()
			.then((loaded) => {
				if (cancelled) return;
				setStatus(loaded);
				setDraft({ ...loaded.settings, noProxy: "" });
				setError(loaded.passwordUnavailable ? "passwordUnavailable" : null);
				setReload(false);
			})
			.catch(() => {
				if (!cancelled) {
					setError("loadFailed");
					setReload(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [reload]);

	function change(patch: Partial<NetworkSettings>) {
		setDraft((current) => (current ? { ...current, ...patch } : current));
		setError(null);
		setSaved(false);
	}

	async function testConnection() {
		if (!draft || testing) return;
		setTesting(true);
		setError(null);
		try {
			const result = await getPi().testNetworkConnection({ settings: draft });
			if (result.ok) {
				pushToast("info", "settings.network.testSuccess", `${result.latencyMs} ms`);
			} else {
				pushToast("error", `settings.network.${result.error}`);
			}
		} catch {
			pushToast("error", "settings.network.testFailed");
		} finally {
			setTesting(false);
		}
	}

	async function save() {
		if (!draft || saving || testing) return;
		setSaving(true);
		setError(null);
		setSaved(false);
		try {
			const settings =
				draft.mode === "manual" && !draft.proxyUrl.trim() && !draft.username && !draft.password
					? { ...draft, mode: "direct" as const }
					: draft;
			const result = await getPi().saveNetworkSettings({ settings });
			if (!result.ok) {
				setError(result.error);
				return;
			}
			setStatus(result.status);
			setDraft(result.status.settings);
			setSaved(true);
		} catch {
			setError("saveFailed");
		} finally {
			setSaving(false);
		}
	}

	if (!draft) {
		return error ? (
			<div role="alert" className="text-ui-13 text-red-500">
				{t(`settings.network.${error}`)}
				<Button onClick={() => setReload(true)}>{t("settings.network.retry")}</Button>
			</div>
		) : (
			<p className="text-ui-13 text-ink-faint">{t("settings.loading")}</p>
		);
	}

	const dirty = !status || JSON.stringify(draft) !== JSON.stringify(status.settings);
	return (
		<form
			className="flex flex-col gap-5"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<div>
				<h3 className="text-ui-13 font-medium text-ink">{t("settings.network.title")}</h3>
				<p className="mt-1 text-ui-11 leading-relaxed text-ink-faint">{t("settings.network.hint")}</p>
			</div>
			<fieldset disabled={saving || testing} aria-busy={testing} className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-2">
					{MODES.map((mode) => (
						<label
							key={mode}
							className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-ui-13 ${draft.mode === mode ? "bg-hover text-ink" : "text-ink-dim hover:bg-hover"}`}
						>
							<input
								type="radio"
								name="proxy-mode"
								value={mode}
								checked={draft.mode === mode}
								onChange={() => change({ mode })}
								className="accent-current"
							/>
							<span>{t(`settings.network.${mode}`)}</span>
						</label>
					))}
				</div>
				{draft.mode === "manual" && (
					<div className="flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-soft">
						<div className="flex items-center gap-2">
							<input
								type="text"
								value={draft.proxyUrl}
								onChange={(event) => change({ proxyUrl: event.target.value })}
								placeholder="http://127.0.0.1:7897"
								autoComplete="off"
								aria-label={t("settings.network.proxyUrl")}
								spellCheck={false}
								className={`${INPUT_CLASS} flex-1 font-mono`}
							/>
							<Tooltip label={t(testing ? "settings.network.testing" : "settings.network.test")} align="end">
								<Button
									onClick={() => void testConnection()}
									disabled={!draft.proxyUrl.trim()}
									aria-label={t(testing ? "settings.network.testing" : "settings.network.test")}
									aria-busy={testing}
									className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-border p-0!"
								>
									{testing ? (
										<TodoSpinnerIcon size={22} className="shrink-0 animate-spin motion-reduce:animate-none" />
									) : (
										<SearchIcon size={22} className="shrink-0" />
									)}
								</Button>
							</Tooltip>
							<Tooltip label={t("settings.network.clear")} align="end">
								<Button
									onClick={() => {
										change({ proxyUrl: "", username: "", password: "", noProxy: "" });
										setShowPassword(false);
									}}
									aria-label={t("settings.network.clear")}
									className="inline-flex h-9 w-9 shrink-0 items-center justify-center border border-border p-0!"
								>
									<CloseIcon size={14} />
								</Button>
							</Tooltip>
							<Button
								type="submit"
								variant="primary"
								disabled={!dirty}
								className="h-9 shrink-0 whitespace-nowrap"
							>
								{t(saving ? "settings.network.saving" : "settings.network.save")}
							</Button>
						</div>
						<div className="grid grid-cols-1 gap-3 min-[520px]:grid-cols-2">
							<input
								type="text"
								value={draft.username}
								onChange={(event) => change({ username: event.target.value })}
								placeholder={t("settings.network.username")}
								aria-label={t("settings.network.username")}
								autoComplete="off"
								spellCheck={false}
								className={INPUT_CLASS}
							/>
							<div className="relative min-w-0">
								<input
									type={showPassword ? "text" : "password"}
									value={draft.password}
									onChange={(event) => change({ password: event.target.value })}
									placeholder={t("settings.network.password")}
									aria-label={t("settings.network.password")}
									autoComplete="off"
									spellCheck={false}
									className={`${INPUT_CLASS} pr-10`}
								/>
								<div className="absolute inset-y-0 right-1 flex items-center">
									<Tooltip
										label={t(
											showPassword ? "settings.network.hidePassword" : "settings.network.showPassword",
										)}
										align="end"
									>
										<Button
											aria-label={t(
												showPassword ? "settings.network.hidePassword" : "settings.network.showPassword",
											)}
											aria-pressed={showPassword}
											onClick={() => setShowPassword(!showPassword)}
											className="px-2"
										>
											<svg
												width="16"
												height="16"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="1.5"
												aria-hidden="true"
											>
												<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
												<circle cx="12" cy="12" r="3" />
												{showPassword && <path d="m3 3 18 18" />}
											</svg>
										</Button>
									</Tooltip>
								</div>
							</div>
						</div>
						<p className="text-ui-11 text-ink-faint">{t("settings.network.proxyUrlHint")}</p>
					</div>
				)}
				{draft.mode !== "manual" && (
					<Button type="submit" variant="primary" disabled={!dirty} className="self-start">
						{t(saving ? "settings.network.saving" : "settings.network.save")}
					</Button>
				)}
			</fieldset>
			{error && (
				<p role="alert" className="text-ui-12 text-red-500">
					{t(`settings.network.${error}`)}
				</p>
			)}
			{status?.restartRequired && (
				<p role="status" className="text-ui-12 text-ink-2">
					{t("settings.network.restartRequired")}
				</p>
			)}
			{saved && !status?.restartRequired && (
				<p role="status" className="text-ui-12 text-ink-dim">
					{t("settings.network.saved")}
				</p>
			)}
		</form>
	);
}
