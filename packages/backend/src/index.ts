export { createLogger, initLogging, type Logger } from "./log";
export { fetchPackageCatalog, parseCatalogHtml } from "./package-catalog";
export { makePermissionGateExtension, type PermissionGateOptions } from "./permission-extension";
export {
	createPermissionConfigLoader,
	DEFAULT_PERMISSION_CONFIG,
	evaluateBashCommand,
	evaluateRules,
	extractShellExecArg,
	extractSubstitutions,
	loadPermissionConfig,
	matchPattern,
	matchTextFor,
	mergeWithDefaults,
	type PermissionAction,
	type PermissionConfig,
	type PermissionRule,
	type PermissionRules,
	permissionConfigPath,
	setPermissionEnabled,
	splitShellSegments,
	suggestPattern,
} from "./permission-rules";
export { PermissionGate, type PermissionResponder } from "./permissions";
export { PiBackend, type PiBackendOptions } from "./pi-backend";
export { type RegisteredSession, SessionRegistry } from "./session-registry";
export { SettingsService } from "./settings";
export { makeShowImageTool, resolveShowImagePath, type ShowImageDetails } from "./show-image-tool";
export { TraceRecorder } from "./trace";
export {
	buildTrustOptions,
	type ResolveTrustOptions,
	resolveProjectTrust,
	TrustGate,
	type TrustOptionInternal,
	type TrustResponder,
} from "./trust";
export {
	assertPublicUrl,
	type Cidr,
	FAKE_IP_CIDR,
	htmlToText,
	ipInCidr,
	isPublicIp,
	makeWebFetchTool,
	parseCidr,
	type WebFetchDetails,
	type WebFetchOptions,
} from "./webfetch";
