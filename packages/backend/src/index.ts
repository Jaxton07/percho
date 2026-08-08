export { createLogger, initLogging, type Logger } from "./log";
export { makePermissionGateExtension } from "./permission-extension";
export {
	createPermissionConfigLoader,
	DEFAULT_PERMISSION_CONFIG,
	evaluateRules,
	loadPermissionConfig,
	matchPattern,
	matchTextFor,
	mergeWithDefaults,
	type PermissionAction,
	type PermissionConfig,
	type PermissionRule,
	type PermissionRules,
	setPermissionEnabled,
	suggestPattern,
} from "./permission-rules";
export { PermissionGate, type PermissionResponder } from "./permissions";
export { PiBackend, type PiBackendOptions } from "./pi-backend";
export { type RegisteredSession, SessionRegistry } from "./session-registry";
export { SettingsService } from "./settings";
export { TraceRecorder } from "./trace";
export {
	buildTrustOptions,
	type ResolveTrustOptions,
	resolveProjectTrust,
	TrustGate,
	type TrustOptionInternal,
	type TrustResponder,
} from "./trust";
