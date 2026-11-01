import { create } from "zustand";
import { getPi } from "../api";
import { runSessionSwitchDiagnostics } from "../lib/run-session-switch-diagnostics";
import { useLocalSettingsStore } from "./settings";

type Report = Awaited<ReturnType<typeof runSessionSwitchDiagnostics>>;
interface State {
	busy: boolean;
	progress: number;
	failed: boolean;
	report: Report | null;
	start: () => Promise<void>;
}
/** 只保留数字报告，不持久化；关闭设置后继续测量真实可编辑的聊天页。 */
export const useSessionSwitchDiagnostics = create<State>((set, get) => ({
	busy: false,
	progress: 0,
	failed: false,
	report: null,
	start: async () => {
		if (get().busy) return;
		set({ busy: true, progress: 0, failed: false, report: null });
		let hidden = false;
		try {
			await getPi().getSessionSwitchFixtures();
			useLocalSettingsStore.getState().setOpen(false);
			hidden = true;
			const report = await runSessionSwitchDiagnostics((done, total) =>
				set({ progress: Math.round((done / total) * 100) }),
			);
			set({ report });
		} catch {
			set({ failed: true });
		} finally {
			set({ busy: false });
			if (hidden) useLocalSettingsStore.getState().openWith("about");
		}
	},
}));
