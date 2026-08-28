import type { LoginAuthPrompt } from "@percho/shared";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n";
import { useProviderLoginStore } from "../../../stores/provider-login";
import { Button } from "../../ui/Button";

/**
 * 订阅登录（OAuth）对话框：渲染 backend LoginService 桥接来的 AuthInteraction 事件。
 * 状态机：auth_url（自动开浏览器 + 手动粘贴兜底）/ device_code（验证码 + SDK 轮询）/
 * select·text·manual_code 提示 / progress·info 状态行 / error 保留展示。
 * SDK 提示文案为英文原文（provider 自带），对话框框架文案走 i18n。
 */
export function LoginDialog() {
	const t = useT();
	const login = useProviderLoginStore((s) => s.login);
	const respond = useProviderLoginStore((s) => s.respondLoginPrompt);
	const cancel = useProviderLoginStore((s) => s.cancelProviderLogin);
	const dismiss = useProviderLoginStore((s) => s.dismissLogin);

	// 卸载清理 = 关闭设置弹窗（ProvidersPanel 随 SettingsDialog 整树卸载）时取消进行中流程：
	// 有活跃流程且非 error 态 → invoke 取消；error 态保留（对话框重开后仍展示错误）。login 状态无条件清空。
	// （LoginDialog 恒挂载于 ProvidersPanel，login 为 null 时渲染 null 不卸载组件，本 effect 只在真卸载时跑）
	useEffect(
		() => () => {
			const s = useProviderLoginStore.getState();
			if (s.login && !s.login.error) s.cancelProviderLogin();
			useProviderLoginStore.setState({ login: null });
		},
		[],
	);

	if (!login) return null;
	const { pendingPrompt, deviceCode, authUrl, infoLinks } = login;
	const prompt = pendingPrompt?.prompt;

	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/20" role="dialog" aria-modal>
			<div className="w-[440px] rounded-xl border border-border bg-surface p-4 shadow-dialog">
				<h3 className="text-sm font-semibold text-ink">
					{t("settings.login.title", { name: login.providerName })}
				</h3>

				{/* 设备码：验证码 + 验证链接，SDK 侧自行轮询 */}
				{deviceCode && (
					<div className="mt-3 rounded-lg bg-hover px-3 py-2.5">
						<p className="text-[11px] text-ink-faint">{t("settings.login.deviceCodeHint")}</p>
						<p className="mt-1 select-all text-center font-mono text-lg font-semibold tracking-widest text-ink">
							{deviceCode.userCode}
						</p>
						<button
							type="button"
							className="mt-1 block w-full truncate text-center text-[11px] text-ink-dim underline underline-offset-2 hover:text-ink"
							onClick={() => void window.pi.openExternal(deviceCode.verificationUri)}
						>
							{deviceCode.verificationUri}
						</button>
						{deviceCode.expiresInSeconds ? (
							<p className="mt-1 text-center text-[10px] text-ink-faint">
								{t("settings.login.deviceCodeExpires", {
									minutes: Math.ceil(deviceCode.expiresInSeconds / 60),
								})}
							</p>
						) : null}
					</div>
				)}

				{/* 浏览器授权：已自动打开，URL 可点击/复制兜底 */}
				{authUrl && (
					<div className="mt-3 rounded-lg bg-hover px-3 py-2.5">
						<p className="text-[11px] text-ink-2">{t("settings.login.browserHint")}</p>
						<button
							type="button"
							className="mt-1 block w-full truncate text-left font-mono text-[11px] text-ink-dim underline underline-offset-2 hover:text-ink"
							title={authUrl.url}
							onClick={() => void window.pi.openExternal(authUrl.url)}
						>
							{authUrl.url}
						</button>
						{authUrl.instructions && (
							<p className="mt-1 text-[10px] text-ink-faint">{authUrl.instructions}</p>
						)}
					</div>
				)}

				{/* 选择提示（如 codex 的浏览器/设备码二选一） */}
				{prompt?.type === "select" && (
					<div className="mt-3">
						<p className="text-[12px] text-ink-2">{prompt.message}</p>
						<div className="mt-2 flex flex-col items-stretch gap-1.5">
							{prompt.options.map((option) => (
								<Button
									key={option.id}
									variant="primary"
									className="justify-start text-left"
									onClick={() => respond(option.id)}
								>
									{option.label}
									{option.description && (
										<span className="ml-1 text-[11px] opacity-70">{option.description}</span>
									)}
								</Button>
							))}
						</div>
					</div>
				)}

				{/* 输入提示（manual_code / text / secret）；key=promptId 换提示时重挂载重置输入 */}
				{prompt && prompt.type !== "select" && pendingPrompt && (
					<PromptInput key={pendingPrompt.promptId} prompt={prompt} onSubmit={respond} />
				)}

				{/* info 链接 */}
				{infoLinks && infoLinks.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-2">
						{infoLinks.map((link) => (
							<button
								key={link.url}
								type="button"
								className="text-[11px] text-ink-dim underline underline-offset-2 hover:text-ink"
								onClick={() => void window.pi.openExternal(link.url)}
							>
								{link.label ?? link.url}
							</button>
						))}
					</div>
				)}

				{/* 状态行：等待中 spinner + 最新 progress/info 文案 */}
				{!login.error && (
					<div className="mt-3 flex items-center gap-2 text-[11px] text-ink-faint">
						<span className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
						<span className="truncate">{login.statusLine ?? t("settings.login.waiting")}</span>
					</div>
				)}

				{login.error && (
					<p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] break-all text-red-600">
						{t("settings.login.failed")}：{login.error}
					</p>
				)}

				<div className="mt-4 flex justify-end">
					{login.error ? (
						<Button variant="primary" onClick={dismiss}>
							{t("common.close")}
						</Button>
					) : (
						<Button onClick={cancel}>{t("common.cancel")}</Button>
					)}
				</div>
			</div>
		</div>
	);
}

/** 输入提示（manual_code / text / secret）：本地输入态随 promptId 重挂载重置 */
function PromptInput({
	prompt,
	onSubmit,
}: {
	prompt: Exclude<LoginAuthPrompt, { type: "select" }>;
	onSubmit: (value: string) => void;
}) {
	const t = useT();
	const [input, setInput] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	// manual_code 允许空提交（SDK 按缺省处理），其余空值无意义
	const allowEmpty = prompt.type === "manual_code";
	const submit = () => {
		if (!allowEmpty && !input.trim()) return;
		onSubmit(input.trim());
	};

	return (
		<div className="mt-3">
			<p className="text-[12px] text-ink-2">{prompt.message}</p>
			<div className="mt-2 flex items-center gap-2">
				<input
					ref={inputRef}
					type={prompt.type === "secret" ? "password" : "text"}
					className="min-w-0 flex-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none focus:border-ink-faint"
					placeholder={prompt.placeholder}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && submit()}
				/>
				<Button variant="primary" onClick={submit} disabled={!allowEmpty && !input.trim()}>
					{t("settings.login.submit")}
				</Button>
			</div>
		</div>
	);
}
