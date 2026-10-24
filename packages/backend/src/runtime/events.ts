import type { EnvironmentApi } from "@percho/shared";
import type { PiBackend } from "../pi-backend";

type EventMethod = { [K in keyof EnvironmentApi]: K extends `on${string}` ? K : never }[keyof EnvironmentApi];

/** Explicit backend adapters, checked against the subscription contract rather than a second channel list. */
export function bindExecutionEvents(
	backend: PiBackend,
	emit: (method: EventMethod, payload: unknown) => void,
): () => void {
	const subscriptions: Pick<EnvironmentApi, EventMethod> = {
		onEvent: (handler) => backend.onEvent((sessionId, event) => handler({ sessionId, event })),
		onPermissionRequest: (handler) => backend.onPermissionRequest(handler),
		onPermissionResolved: (handler) => backend.onPermissionResolved(handler),
		onTrustRequest: (handler) => backend.onTrustRequest(handler),
		onExtensionDialogRequest: (handler) => backend.onExtensionDialogRequest(handler),
		onExtensionDialogResolved: (handler) => backend.onExtensionDialogResolved(handler),
		onExtensionNotify: (handler) => backend.onExtensionNotify(handler),
		onExtensionEditorText: (handler) => backend.onExtensionEditorText(handler),
		onProviderLoginEvent: (handler) => backend.onLoginEvent(handler),
		onMcpServersChanged: (handler) => backend.onMcpServersChanged(handler),
		onChannelSubscriptionsChanged: (handler) => backend.onChannelSubscriptionsChanged(handler),
	};
	const offs = Object.entries(subscriptions).map(([method, subscribe]) =>
		subscribe((payload: unknown) => emit(method as EventMethod, payload)),
	);
	return () => {
		for (const off of offs) off();
	};
}
