import { CACHE_WARMING_MODES, type CacheWarmingInfo, type CacheWarmingMode } from "@percho/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { useEnvironment } from "../../environment-context";
import { useI18nStore, useT } from "../../i18n";
import { Select } from "../ui/Select";
import { HintIcon } from "./HintIcon";

export function CacheWarmingSettings() {
	const t = useT();
	const language = useI18nStore((state) => state.language);
	const environment = useEnvironment();
	const api = useMemo(() => getExecutionApi(environment), [environment]);
	const [info, setInfo] = useState<CacheWarmingInfo | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const generation = useRef(0);
	const revision = useRef(0);
	const savingRef = useRef(false);
	useEffect(() => {
		const current = ++generation.current;
		let reading = false;
		const refresh = async () => {
			if (reading || savingRef.current || document.hidden) return;
			reading = true;
			const request = ++revision.current;
			try {
				const value = await api.getCacheWarming();
				if (current === generation.current && request === revision.current) {
					setInfo(value);
					setError("");
				}
			} catch (error) {
				if (current === generation.current && request === revision.current)
					setError(error instanceof Error ? error.message : String(error));
			} finally {
				reading = false;
			}
		};
		void refresh();
		const interval = setInterval(() => void refresh(), 5000);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			++generation.current;
			clearInterval(interval);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [api]);
	const save = async (mode: CacheWarmingMode) => {
		if (savingRef.current) return;
		const current = generation.current;
		++revision.current;
		savingRef.current = true;
		setSaving(true);
		try {
			const value = await api.setCacheWarming({ mode });
			if (current === generation.current) {
				setInfo(value);
				setError("");
			}
		} catch (error) {
			if (current === generation.current) setError(error instanceof Error ? error.message : String(error));
		} finally {
			savingRef.current = false;
			if (current === generation.current) setSaving(false);
		}
	};
	return (
		<section className="flex flex-col gap-2" aria-label={t("settings.cacheWarming")}>
			<div className="flex items-center justify-between gap-4">
				<div className="flex min-w-0 items-center gap-1.5">
					<h3 className="text-ui-13 font-medium text-ink">{t("settings.cacheWarming")}</h3>
					<HintIcon label={t("settings.cacheWarmingHint")} />
				</div>
				<Select
					variant="ghost"
					ariaLabel={t("settings.cacheWarming")}
					value={info?.mode ?? "idle"}
					disabled={!info || saving}
					options={CACHE_WARMING_MODES.map((mode) => ({
						value: mode,
						label: t(`settings.cacheWarmingModes.${mode}`),
					}))}
					onChange={(mode) => void save(mode as CacheWarmingMode)}
				/>
			</div>
			{error && (
				<p role="alert" className="text-ui-11 text-danger">
					{error}
				</p>
			)}
			{!info && !error && <p className="text-ui-11 text-ink-faint">{t("settings.cacheWarmingLoading")}</p>}
			{info?.sessions.length === 0 && (
				<p className="text-ui-11 text-ink-faint">{t("settings.cacheWarmingEmpty")}</p>
			)}
			{info?.sessions.map((session) => (
				<div
					key={session.sessionId}
					className="flex items-start justify-between gap-4 text-ui-11 text-ink-faint"
				>
					<span className="min-w-0 truncate">{session.name}</span>
					<span className="shrink-0 text-right">
						{t(`settings.cacheWarmingStates.${session.state}`)}
						{session.state === "inactive" &&
							session.reason &&
							` · ${t(`settings.cacheWarmingReasons.${session.reason}`)}`}
						{session.state === "scheduled" &&
							session.nextWarmAt &&
							` · ${new Date(session.nextWarmAt).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US")}`}
					</span>
				</div>
			))}
		</section>
	);
}
