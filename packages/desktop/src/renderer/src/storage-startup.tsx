import type { StorageStartupAction, StorageStartupState } from "@percho/shared";
import { createRoot } from "react-dom/client";
import { StorageStartup } from "./components/startup/StorageStartup";
import { translate, useI18nStore } from "./i18n";
import { onSplashExit, setSplashMessage } from "./splash";
import "./styles/globals.css";
import "./styles/startup.css";

/** Same document, splash DOM and clock. Workbench stores load only after main permits it. */
export function renderStorageStartup() {
	document.documentElement.dataset.storageStartup = "true";
	document.documentElement.dataset.startupView = "splash";
	const host = document.createElement("div");
	host.id = "startup-root";
	document.body.append(host);
	const root = createRoot(host);
	let setupShown = false;
	let launching = false;
	let received = false;
	let disposed = false;
	let state: StorageStartupState | null = null;
	let error = "";
	const action = (value: StorageStartupAction) => {
		error = "";
		void window.pi.storageStartupAct({ action: value }).catch((cause) => {
			error = String(cause);
			render();
		});
	};
	const render = () => {
		if (disposed) return;
		if (error || (state && ["choice", "existing", "error"].includes(state.phase))) setupShown = true;
		if (setupShown) document.documentElement.dataset.startupView = "setup";
		setSplashMessage(translate(useI18nStore.getState().language, "storageStartup.preparing"));
		root.render(setupShown ? <StorageStartup state={state} error={error} onAction={action} /> : null);
		if (state?.phase === "launching" && !launching) {
			launching = true;
			void import("./workbench").catch((cause) => {
				error = String(cause);
				render();
			});
		}
	};
	const off = window.pi.onStorageStartup((value) => {
		received = true;
		state = value;
		render();
	});
	onSplashExit(() => {
		disposed = true;
		off();
		root.unmount();
		host.remove();
	});
	void window.pi
		.storageStartupGet()
		.then((value) => {
			if (!received) {
				state = value;
				render();
			}
		})
		.catch((cause) => {
			error = String(cause);
			render();
		});
	render();
}
