import type { ProviderInfo } from "@percho/shared";
import { useState } from "react";
import { useT } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settings";

const inputClass =
	"w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint disabled:cursor-not-allowed disabled:text-ink-faint";

/**
 * 内置 provider 的端点覆写编辑（pi 官方语义）：只填 baseUrl（可选）+ Key。
 * 模型列表永远共享官方配置，不出现在表单里；baseUrl 留空保存 = 清除覆写回官方。
 */
export function BuiltinProviderEditForm({
	provider,
	onDone,
}: {
	provider: ProviderInfo;
	onDone: () => void;
}) {
	const t = useT();
	const setProviderBaseUrl = useSettingsStore((s) => s.setProviderBaseUrl);
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
	const [key, setKey] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const save = async () => {
		setSubmitting(true);
		try {
			await setProviderBaseUrl(provider.id, baseUrl, key || undefined);
			onDone();
		} catch {
			// 错误已写入 store.error，表单保持打开
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="mt-2 rounded-xl border border-border p-3">
			<h3 className="text-[13px] font-medium text-ink">
				{t("settings.providers.builtinEditTitle", { name: provider.name })}
			</h3>
			<div className="mt-2">
				<input
					className={inputClass}
					placeholder={t("settings.providers.builtinBaseUrl")}
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
				/>
			</div>
			<div className="mt-2">
				<input
					type="password"
					className={inputClass}
					placeholder={t("settings.providers.customKeyKeep")}
					value={key}
					onChange={(e) => setKey(e.target.value)}
				/>
			</div>
			<p className="mt-2 text-[10px] leading-relaxed text-ink-faint">{t("settings.providers.builtinHint")}</p>
			<div className="mt-2 flex justify-end gap-2">
				<button
					type="button"
					className="rounded-lg px-3 py-1.5 text-[12px] text-ink-dim transition-colors hover:bg-hover"
					onClick={onDone}
				>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-40"
					onClick={() => void save()}
					disabled={submitting}
				>
					{submitting ? t("settings.providers.submitting") : t("common.save")}
				</button>
			</div>
		</div>
	);
}
