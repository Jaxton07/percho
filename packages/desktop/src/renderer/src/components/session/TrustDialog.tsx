import type { TrustOption, TrustRequest } from "@percho/shared";
import { useT } from "../../i18n";
import { Button } from "../ui/Button";

/** 项目信任对话框：添加项目/创建会话前确认是否加载项目本地资源（.pi/ 扩展、skills 等） */
export function TrustDialog({
	requests,
	onRespond,
}: {
	requests: TrustRequest[];
	onRespond: (requestId: string, optionIndex: number) => void;
}) {
	const t = useT();
	const request = requests[0];
	if (!request) return null;

	const label = (option: TrustOption): string => {
		switch (option.key) {
			case "trust":
				return t("trust.trust");
			case "deny":
				return t("trust.deny");
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20" role="dialog" aria-modal>
			<div className="w-[440px] rounded-xl border border-border bg-surface p-4 shadow-dialog">
				<h3 className="text-sm font-semibold text-ink">{t("trust.title")}</h3>
				<p className="mt-1.5 rounded-lg bg-hover px-2.5 py-1.5 font-mono text-[12px] break-all text-ink-2 select-text">
					{request.cwd}
				</p>
				<p className="mt-2 text-[12px] leading-relaxed text-ink-2">{t("trust.message")}</p>
				<div className="mt-4 flex flex-col items-stretch gap-1.5">
					{request.options.map((option, index) => (
						<Button
							key={option.key}
							variant={option.key === "trust" ? "primary" : "ghost"}
							tone={option.key.startsWith("deny") ? "danger" : "default"}
							className="justify-start text-left"
							onClick={() => onRespond(request.id, index)}
						>
							{label(option)}
						</Button>
					))}
				</div>
				{requests.length > 1 && (
					<p className="mt-2 text-[11px] text-ink-faint">
						{t("trust.queued", { count: requests.length - 1 })}
					</p>
				)}
			</div>
		</div>
	);
}
