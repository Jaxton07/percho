import { type BrowserWindow, type ContextMenuParams, type IpcMainInvokeEvent, Menu } from "electron";

type Request = { token: string; x: number; y: number };
type Context = Pick<ContextMenuParams, "x" | "y" | "frame" | "editFlags" | "isEditable">;
const brokers = new WeakMap<Electron.WebContents, ComposerMenuBroker>();

/** One pending native context and one matching editor request; neither survives navigation. */
export class ComposerMenuBroker {
	private requestValue?: Request;
	private active?: Request;
	private contextValue?: Context;
	private timer?: ReturnType<typeof setTimeout>;
	private closeMenu?: () => void;
	constructor(
		private readonly show: (context: Context, valid: () => boolean, closed: () => void) => () => void,
	) {}
	request(request: Request) {
		if (
			!request ||
			typeof request.token !== "string" ||
			request.token.length > 100 ||
			!request.token ||
			!Number.isFinite(request.x) ||
			!Number.isFinite(request.y) ||
			request.x < 0 ||
			request.y < 0
		)
			throw new Error("Invalid editor menu request");
		this.releaseActive();
		this.requestValue = request;
		this.expire();
		this.match();
	}
	context(context: Context) {
		this.releaseActive();
		this.contextValue = context;
		this.expire();
		this.match();
	}
	cancel(token?: string) {
		if (token && this.requestValue?.token !== token && this.active?.token !== token) return;
		clearTimeout(this.timer);
		this.requestValue = undefined;
		this.contextValue = undefined;
		this.releaseActive();
	}
	private releaseActive() {
		this.active = undefined;
		const close = this.closeMenu;
		this.closeMenu = undefined;
		close?.();
	}
	private expire() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.cancel(), 1000);
	}
	private match() {
		const request = this.requestValue,
			context = this.contextValue;
		if (!request || !context) return;
		if (Math.abs(request.x - context.x) > 2 || Math.abs(request.y - context.y) > 2) {
			this.cancel();
			return;
		}
		clearTimeout(this.timer);
		this.contextValue = undefined;
		this.requestValue = undefined;
		this.active = request;
		this.closeMenu = this.show(
			context,
			() => this.active === request,
			() => {
				// Cocoa closes the popup before dispatching the selected item's click.
				// Target invalidation is independent; no pending context can reuse this request.
				if (this.active === request) this.closeMenu = undefined;
			},
		);
	}
}

export function attachComposerEditMenu(window: BrowserWindow) {
	const contents = window.webContents;
	const broker = new ComposerMenuBroker((context, valid, closed) => {
		const actions = [
			["cut", context.isEditable && context.editFlags.canCut],
			["copy", context.editFlags.canCopy],
			["paste", context.isEditable && context.editFlags.canPaste],
			["selectAll", context.editFlags.canSelectAll],
		] as const;
		// Use native roles only to obtain localized labels; a role on the actual item would bypass click.
		const labels = Menu.buildFromTemplate(actions.map(([role]) => ({ role }))).items;
		const menu = Menu.buildFromTemplate(
			actions.map(([role, enabled], index) => ({
				label: labels[index]?.label ?? role,
				accelerator: ["CommandOrControl+X", "CommandOrControl+C", "CommandOrControl+V", "CommandOrControl+A"][
					index
				],
				enabled,
				click: () => {
					if (valid() && !contents.isDestroyed() && context.frame === contents.mainFrame) contents[role]();
				},
			})),
		);
		menu.popup({ window, x: Math.round(context.x), y: Math.round(context.y), callback: closed });
		return () => menu.closePopup(window);
	});
	brokers.set(contents, broker);
	contents.on("context-menu", (_event, params) => {
		if (params.frame === contents.mainFrame) broker.context(params);
	});
	contents.on("did-start-navigation", () => broker.cancel());
	contents.once("destroyed", () => {
		broker.cancel();
		brokers.delete(contents);
	});
}

function brokerFor(event?: IpcMainInvokeEvent) {
	if (!event || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
		throw new Error("Invalid editor menu source");
	const broker = brokers.get(event.sender);
	if (!broker) throw new Error("Editor menu window is unavailable");
	return broker;
}

export function showComposerEditMenu(request: Request, event?: IpcMainInvokeEvent) {
	brokerFor(event).request(request);
}
export function cancelComposerEditMenu({ token }: { token: string }, event?: IpcMainInvokeEvent) {
	if (typeof token !== "string") throw new Error("Invalid editor token");
	brokerFor(event).cancel(token);
}
