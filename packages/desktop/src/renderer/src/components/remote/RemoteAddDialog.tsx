import { useCallback, useEffect, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { SettingsIcon } from "../icons/SettingsIcon";
import { Tooltip } from "../ui/Tooltip";
import { RemoteActionError } from "./RemoteActionError";
import { RemoteModal } from "./RemoteModal";

export function RemoteAddDialog({
	aliasesSaved,
	busy,
	slotKey,
	onClose,
	onSave,
}: {
	aliasesSaved: string[];
	busy: boolean;
	slotKey: string;
	onClose: () => void;
	onSave: (alias: string) => Promise<void>;
}) {
	const t = useT();
	const [aliases, setAliases] = useState<string[]>([]);
	const [selected, setSelected] = useState("");
	const [manual, setManual] = useState(false);
	const [refreshHovered, setRefreshHovered] = useState(false);
	const [refreshFocused, setRefreshFocused] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [incomplete, setIncomplete] = useState(false);
	const [failed, setFailed] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const sequence = useRef(0);
	const focusedCandidates = useRef(false);
	const originalSlot = useRef(slotKey);
	const unavailable = busy || slotKey !== originalSlot.current;
	const refresh = useCallback(() => {
		const id = ++sequence.current;
		setLoading(true);
		setFailed(false);
		void getPi()
			.remoteListSshAliases()
			.then((result) => {
				if (sequence.current !== id) return;
				setAliases(result.aliases);
				setIncomplete(result.incomplete);
			})
			.catch(() => {
				if (sequence.current === id) setFailed(true);
			})
			.finally(() => {
				if (sequence.current === id) {
					setLoading(false);
					setLoaded(true);
				}
			});
	}, []);
	useEffect(() => {
		refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh]);
	useEffect(() => {
		if (manual) document.getElementById("remote-manual")?.focus();
		else if (loaded && !focusedCandidates.current) {
			focusedCandidates.current = true;
			document.querySelector<HTMLInputElement>('input[name="remote-alias"]:not(:disabled)')?.focus();
		}
	}, [manual, loaded]);
	const submit = async () => {
		if (saving || unavailable || !selected.trim()) return;
		setSaving(true);
		setError("");
		try {
			await onSave(selected.trim());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};
	return (
		<RemoteModal
			title={t(manual ? "remote.ux.manualTitle" : "remote.ux.addTitle")}
			locked={saving}
			onClose={onClose}
			footer={
				<>
					<div className="flex items-center gap-2">
						{manual ? (
							<button
								className="remote-button"
								type="button"
								disabled={saving}
								onClick={() => {
									focusedCandidates.current = false;
									setManual(false);
									setSelected("");
								}}
							>
								{t("remote.ux.back")}
							</button>
						) : (
							<>
								<Tooltip
									label={t("remote.refreshAliases")}
									open={refreshHovered || refreshFocused}
									zIndex={90}
								>
									<button
										type="button"
										className="remote-icon"
										aria-label={t("remote.refreshAliases")}
										onMouseEnter={() => setRefreshHovered(true)}
										onMouseLeave={() => setRefreshHovered(false)}
										onFocus={() => setRefreshFocused(true)}
										onBlur={() => setRefreshFocused(false)}
										disabled={loading || saving}
										onClick={refresh}
									>
										<SettingsIcon name="refresh" className={loading ? "remote-spin" : ""} />
									</button>
								</Tooltip>
								<button
									type="button"
									className="remote-button"
									disabled={saving}
									onClick={() => {
										setManual(true);
										setSelected("");
									}}
								>
									{t("remote.ux.manual")}
								</button>
							</>
						)}
					</div>
					<button
						type="button"
						className="remote-primary"
						disabled={!selected.trim() || unavailable || saving || aliasesSaved.includes(selected.trim())}
						onClick={() => void submit()}
					>
						{saving ? t("remote.ux.saving") : t("remote.ux.addConnect")}
					</button>
				</>
			}
		>
			{manual ? (
				<>
					<label className="text-ui-12 text-ink-dim" htmlFor="remote-manual">
						{t("remote.alias")}
					</label>
					<input
						data-initial-focus
						id="remote-manual"
						disabled={saving}
						className="remote-input"
						value={selected}
						onChange={(e) => setSelected(e.target.value)}
					/>
					<p className="remote-note">{t("remote.ux.manualHint")}</p>
				</>
			) : (
				<>
					<div className="remote-alias-list" role="radiogroup" aria-label={t("remote.chooseAlias")}>
						{!loaded && loading ? (
							<div role="status" aria-label={t("remote.ux.loading")}>
								{[0, 1, 2, 3, 4, 5].map((index) => (
									<div key={index} className="remote-alias-skeleton" />
								))}
							</div>
						) : (
							aliases.map((alias, index) => (
								<label className="remote-alias" key={alias}>
									<SettingsIcon name="laptop" size={16} />
									<span className="truncate flex-1">{alias}</span>
									{aliasesSaved.includes(alias) && (
										<span className="text-ui-11 text-ink-faint">{t("remote.ux.added")}</span>
									)}
									<input
										data-initial-focus={
											index === aliases.findIndex((a) => !aliasesSaved.includes(a)) || undefined
										}
										type="radio"
										name="remote-alias"
										value={alias}
										disabled={saving || aliasesSaved.includes(alias)}
										checked={selected === alias}
										onChange={() => setSelected(alias)}
									/>
									<span className="fade-rule remote-rule" aria-hidden="true" />
								</label>
							))
						)}
					</div>
					<p className="remote-note">
						{failed
							? t("remote.ux.discoveryFailed")
							: incomplete
								? t("remote.aliasesIncomplete")
								: loaded && !aliases.length
									? t("remote.aliasesEmpty")
									: ""}
					</p>
				</>
			)}
			{unavailable && (
				<p role="status" className="remote-note">
					{t("remote.ux.busyHint")}
				</p>
			)}
			{error && <RemoteActionError message={error} />}
		</RemoteModal>
	);
}
