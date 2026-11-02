import { create } from "zustand";

export interface ViewAnchor {
	key: string;
	offset: number;
	scrollTop: number;
}
export interface SessionView {
	details: Record<string, boolean>;
	scope: "all" | "latest";
	anchor?: ViewAnchor;
}
const EMPTY_DETAILS: Record<string, boolean> = Object.freeze({});
export const EMPTY_SESSION_VIEW: SessionView = Object.freeze({ details: EMPTY_DETAILS, scope: "all" });
interface SessionViews {
	bySession: Record<string, SessionView>;
	ensure: (sessionId: string) => void;
	setDetail: (sessionId: string, key: string, open: boolean) => void;
	setScope: (sessionId: string, scope: "all" | "latest") => void;
	setAnchor: (sessionId: string, anchor: ViewAnchor) => void;
	forget: (sessionId: string) => void;
	prune: (sessionId: string, valid: ReadonlySet<string>) => void;
}
/** Loaded-session UI state only. This leaf never imports the session/transcript owners. */
export const useSessionViewStore = create<SessionViews>((set) => {
	const update = (sessionId: string, change: (view: SessionView) => SessionView) =>
		set((state) => {
			const previous = state.bySession[sessionId];
			if (!previous) return state;
			const next = change(previous);
			return next === previous ? state : { bySession: { ...state.bySession, [sessionId]: next } };
		});
	return {
		bySession: {},
		ensure: (id) =>
			set((state) =>
				state.bySession[id] ? state : { bySession: { ...state.bySession, [id]: EMPTY_SESSION_VIEW } },
			),
		setDetail: (id, key, open) =>
			update(id, (v) => (v.details[key] === open ? v : { ...v, details: { ...v.details, [key]: open } })),
		setScope: (id, scope) => update(id, (v) => (v.scope === scope ? v : { ...v, scope })),
		setAnchor: (id, anchor) => update(id, (v) => ({ ...v, anchor })),
		forget: (id) =>
			set((state) => {
				if (!state.bySession[id]) return state;
				const bySession = { ...state.bySession };
				delete bySession[id];
				return { bySession };
			}),
		prune: (id, valid) =>
			update(id, (v) => {
				const entries = Object.entries(v.details).filter(([key]) => valid.has(key));
				const anchor = v.anchor && valid.has(v.anchor.key) ? v.anchor : undefined;
				if (entries.length === Object.keys(v.details).length && anchor === v.anchor) return v;
				return { ...v, details: Object.fromEntries(entries), anchor };
			}),
	};
});
