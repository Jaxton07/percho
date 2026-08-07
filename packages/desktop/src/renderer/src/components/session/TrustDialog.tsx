import type { TrustOption, TrustRequest } from "@pi-desktop/shared";
import { useT } from "../../i18n";
import { Button } from "../ui/Button";

/** 项目信任对话框：创建/打开会话前确认是否加载项目本地资源（.pi/ 扩展、skills 等） */
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
			case "trustParent":
				return t("trust.trustParent", { parentPath: option.parentPath ?? "" });
			case "trustSession":
				return t("trust.trustSession");
			case "deny":
				return t("trust.deny");
			case "denySession":
				return t("trust.denySession");
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" role="dialog" aria-modal>
			<div className="w-[440px] rounded-xl border border-zinc-200 bg-white p-4 shadow-xl">
				<h3 className="text-sm font-semibold text-zinc-900">{t("trust.title")}</h3>
				<p className="mt-1.5 rounded-lg bg-zinc-50 px-2.5 py-1.5 font-mono text-[12px] break-all text-zinc-700 select-text">
					{request.cwd}
				</p>
				<p className="mt-2 text-[12px] leading-relaxed text-zinc-600">{t("trust.message")}</p>
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
					<p className="mt-2 text-[11px] text-zinc-400">
						{t("trust.queued", { count: requests.length - 1 })}
					</p>
				)}
			</div>
		</div>
	);
}
