import {
	DEFAULT_VISION_BASE_URL,
	DEFAULT_VISION_MODEL,
	matchVisionPreset,
	VISION_PRESETS,
} from "@percho/shared";
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { useSettingsStore } from "../../stores/settings";
import { Switch } from "../ui/Switch";

const inputClass =
	"w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/** 视觉代理面板：外挂图像识别（纯文本模型用，服务商预设一键切换） */
export function VisionPanel() {
	const t = useT();
	const config = useSettingsStore((s) => s.visionConfig);
	const saveVision = useSettingsStore((s) => s.saveVision);
	const testVision = useSettingsStore((s) => s.testVision);
	const visionTesting = useSettingsStore((s) => s.visionTesting);
	const visionTestResult = useSettingsStore((s) => s.visionTestResult);

	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState(DEFAULT_VISION_BASE_URL);
	const [model, setModel] = useState(DEFAULT_VISION_MODEL);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState(0);

	// 「已保存」提示 2.5s 后自动消失
	useEffect(() => {
		if (!savedAt) return;
		const timer = setTimeout(() => setSavedAt(0), 2500);
		return () => clearTimeout(timer);
	}, [savedAt]);

	const loaded = config !== null;
	const enabled = config?.enabled === true;
	const hasKey = config?.hasKey === true;

	// 配置加载后填充编辑框（key 永不回填，只给存在性）
	const loadedBaseUrl = config?.baseUrl;
	const loadedModel = config?.model;
	useEffect(() => {
		if (loadedBaseUrl !== undefined) setBaseUrl(loadedBaseUrl);
		if (loadedModel !== undefined) setModel(loadedModel);
	}, [loadedBaseUrl, loadedModel]);

	// 预设 id 跟随表单当前值（未保存的编辑也实时反映）
	const preset = matchVisionPreset(baseUrl, model);

	const keyPlaceholder =
		preset === "zhipu"
			? t("settings.vision.keyHintZhipu")
			: preset === "qwen"
				? t("settings.vision.keyHintQwen")
				: t("settings.vision.keyPlaceholder");

	/** 保存表单（key 留空 = 保持不变），返回是否成功 */
	const saveForm = async () => {
		setSaving(true);
		await saveVision({ apiKey, baseUrl, model });
		setSaving(false);
		setSavedAt(Date.now());
		return !useSettingsStore.getState().error;
	};

	const handleTest = async () => {
		// 先保存当前表单再测（否则测的是旧 key）
		await saveForm();
		await testVision();
	};

	const handlePresetChange = (id: string) => {
		if (id === "custom") {
			setAdvancedOpen(true);
			return;
		}
		const hit = VISION_PRESETS.find((p) => p.id === id);
		if (!hit) return;
		setBaseUrl(hit.baseUrl);
		setModel(hit.model);
	};

	const actionButton =
		"rounded-lg border border-border px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:border-border-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40";

	return (
		<div className="flex flex-col gap-6">
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-[13px] font-medium text-ink">{t("settings.vision.title")}</h3>
					<Switch
						checked={enabled}
						disabled={!loaded}
						onCheckedChange={(nextEnabled) => void saveVision({ enabled: nextEnabled })}
					/>
				</div>
				<p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.vision.hint")}</p>
			</div>

			{enabled && (
				<>
					<div className="rounded-lg border border-border bg-surface p-3">
						<p className="text-[11px] leading-relaxed text-ink-dim">{t("settings.vision.privacy")}</p>
					</div>

					<div>
						<label className="text-[12px] text-ink-2" htmlFor="vision-preset">
							{t("settings.vision.preset")}
						</label>
						<select
							id="vision-preset"
							className={`${inputClass} mt-1`}
							value={preset}
							onChange={(e) => handlePresetChange(e.target.value)}
							disabled={saving}
						>
							<option value="zhipu">{t("settings.vision.presetZhipu")}</option>
							<option value="qwen">{t("settings.vision.presetQwen")}</option>
							<option value="custom">{t("settings.vision.presetCustom")}</option>
						</select>
						<p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
							{preset === "zhipu" && t("settings.vision.presetZhipuHint")}
							{preset === "qwen" && t("settings.vision.presetQwenHint")}
							{preset === "custom" && t("settings.vision.presetCustomHint")}
						</p>
					</div>

					<div>
						<label className="text-[12px] text-ink-2" htmlFor="vision-key">
							API Key
						</label>
						<div className="mt-1 flex gap-2">
							<input
								id="vision-key"
								className={inputClass}
								type="password"
								value={apiKey}
								placeholder={hasKey ? t("settings.vision.keyKeep") : keyPlaceholder}
								onChange={(e) => setApiKey(e.target.value)}
								disabled={saving}
								autoComplete="off"
							/>
							{hasKey && (
								<button
									type="button"
									className="shrink-0 rounded-lg border border-border px-2.5 text-[12px] text-ink-2 transition-colors hover:border-border-strong hover:bg-hover"
									onClick={() => void saveVision({ clearApiKey: true })}
								>
									{t("settings.vision.keyClear")}
								</button>
							)}
						</div>
					</div>

					<details open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
						<summary className="cursor-pointer select-none text-[12px] text-ink-2 hover:text-ink">
							{t("settings.vision.advanced")}
						</summary>
						<div className="mt-2 flex flex-col gap-2">
							<div>
								<label className="text-[12px] text-ink-2" htmlFor="vision-baseurl">
									Base URL
								</label>
								<input
									id="vision-baseurl"
									className={inputClass}
									value={baseUrl}
									onChange={(e) => setBaseUrl(e.target.value)}
									disabled={saving}
									spellCheck={false}
								/>
							</div>
							<div>
								<label className="text-[12px] text-ink-2" htmlFor="vision-model">
									{t("settings.vision.modelLabel")}
								</label>
								<input
									id="vision-model"
									className={inputClass}
									value={model}
									onChange={(e) => setModel(e.target.value)}
									disabled={saving}
									spellCheck={false}
								/>
							</div>
						</div>
					</details>

					<div className="flex items-center gap-2">
						<button
							type="button"
							className={actionButton}
							onClick={() => void saveForm()}
							disabled={saving || visionTesting}
						>
							{t("settings.vision.save")}
						</button>
						<button
							type="button"
							className={actionButton}
							onClick={() => void handleTest()}
							disabled={visionTesting || saving}
						>
							{visionTesting ? t("settings.vision.testing") : t("settings.vision.test")}
						</button>
						{savedAt > 0 && !visionTesting && (
							<span className="text-[11px] text-ink-faint">{t("settings.vision.saved")}</span>
						)}
					</div>
					{visionTestResult && (
						<p
							className={`text-[11px] leading-relaxed break-all ${
								visionTestResult.ok ? "text-ink-2" : "text-red-500"
							}`}
						>
							{visionTestResult.ok
								? t("settings.vision.testOk", { reply: visionTestResult.message })
								: t("settings.vision.testFail", { message: visionTestResult.message })}
						</p>
					)}
				</>
			)}
		</div>
	);
}
