import { initSplash } from "./splash";

initSplash();
// Startup migration never imports workbench stores or starts execution IPC.
if (new URLSearchParams(location.search).has("storage-startup")) {
	void import("./storage-startup").then(({ renderStorageStartup }) => renderStorageStartup());
} else {
	void import("./workbench");
}
