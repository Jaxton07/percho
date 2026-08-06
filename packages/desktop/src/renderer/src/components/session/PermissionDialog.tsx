import { getPi } from "../../api";
import { useT } from "../../i18n";
import { useTranscriptStore } from "../../stores/transcript";
import { Button } from "../ui/Button";

/** 权限确认对话框：允许一次 / 拒绝 / 本会话总是允许 */
export function PermissionDialog({ sessionId }: { sessionId: string | null }) {
	const t = useT();
	const pendingPermissions = useTranscriptStore((s) =>
		sessionId ? s.bySession[sessionId]?.pendingPermissions : undefined,
	);
	const resolvePermission = useTranscriptStore((s) => s.resolvePermission);
	const phase = useTranscriptStore((s) => (sessionId ? s.bySession[sessionId]?.phase : undefined));

	const request = pendingPermissions?.[0];
	if (!request || !sessionId || phase !== "awaiting_permission") return null;

	const respond = (answer: "allow" | "deny" | "allowAlways") => {
		void getPi().respondPermission(request.id, answer);
		resolvePermission(sessionId, request.id);
	};

	return (
		<div
			className="absolute inset-0 z-50 flex items-center justify-center bg-black/20"
			role="dialog"
			aria-modal
		>
			<div className="w-[420px] rounded-xl border border-zinc-200 bg-white p-4 shadow-xl">
				<h3 className="text-sm font-semibold text-zinc-900">{request.title}</h3>
				<p className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-zinc-50 p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-700 select-text">
					{request.message}
				</p>
				<div className="mt-4 flex items-center justify-end gap-2">
					<Button onClick={() => respond("deny")}>{t("permission.deny")}</Button>
					<Button onClick={() => respond("allowAlways")}>{t("permission.allowAlways")}</Button>
					<Button variant="primary" onClick={() => respond("allow")}>
						{t("permission.allowOnce")}
					</Button>
				</div>
				{pendingPermissions.length > 1 && (
					<p className="mt-2 text-[11px] text-zinc-400">
						{t("permission.queued", { count: pendingPermissions.length - 1 })}
					</p>
				)}
			</div>
		</div>
	);
}
