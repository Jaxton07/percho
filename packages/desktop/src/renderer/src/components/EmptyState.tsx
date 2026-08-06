import { useSessionsStore } from "../stores/sessions";

/** 空态：超大浅色 Logo + 引导 */
export function EmptyState() {
	const cwd = useSessionsStore((s) => s.cwd);
	const createSession = useSessionsStore((s) => s.createSession);
	const pickDirectory = useSessionsStore((s) => s.pickDirectory);
	const error = useSessionsStore((s) => s.error);

	return (
		<div className="flex h-full flex-col items-center justify-center gap-6 px-8">
			<div className="flex flex-col items-center gap-3">
				<div className="text-7xl font-extrabold tracking-tight text-zinc-200 select-none">pi</div>
				<p className="text-sm text-zinc-400">
					{cwd ? `工作目录：${cwd}` : "选择项目目录后开始与 Pi Agent 对话"}
				</p>
				{error && <p className="max-w-md text-center text-xs text-red-500">{error}</p>}
			</div>
			<div className="flex items-center gap-2">
				<button
					type="button"
					className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-50"
					onClick={() => void pickDirectory()}
				>
					{cwd ? "切换目录" : "选择项目目录"}
				</button>
				{cwd && (
					<button
						type="button"
						className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white transition-colors hover:bg-zinc-700"
						onClick={() => void createSession()}
					>
						开始新对话
					</button>
				)}
			</div>
		</div>
	);
}
