export { createLogger, initLogging, type Logger } from "./log";
export { fetchPackageCatalog, parseCatalogHtml } from "./package-catalog";
export {
	makePermissionGateExtension,
	type PermissionConfirm,
	type PermissionGateOptions,
} from "./permission-extension";
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
	type PermissionOutside,
	type PermissionRule,
	type PermissionRules,
	patternMatchesToolCall,
	permissionConfigPath,
	setPermissionEnabled,
	splitShellSegments,
	suggestPattern,
} from "./permission-rules";
export { PermissionGate, type PermissionRequestMeta, type PermissionResponder } from "./permissions";
export { PiBackend, type PiBackendOptions } from "./pi-backend";
export { type RegisteredSession, SessionRegistry } from "./session-registry";
export { SettingsService } from "./settings";
export { makeShowImageTool, resolveShowImagePath, type ShowImageDetails } from "./show-image-tool";
export { makeTodoReminderExtension } from "./todo-reminder-extension";
export { formatTodoList, makeTodoTool, normalizeTodos } from "./todo-tool";
export { TraceRecorder } from "./trace";
export {
	buildTrustOptions,
	type ResolveTrustOptions,
	resolveProjectTrust,
	TrustGate,
	type TrustOptionInternal,
	type TrustResponder,
} from "./trust";
export { describeImage, pingVision, VisionClientError } from "./vision-client";
export { resolveVisionKey, VisionConfigService } from "./vision-config";
export { makeVisionProxyExtension, type VisionProxyOptions } from "./vision-proxy-extension";
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
export {
	addAllowedPattern,
	addWorkspaceRoot,
	createWorkspacesLoader,
	emptyWorkspaces,
	loadWorkspaces,
	removeWorkspaceRoot,
	suggestRootCandidate,
	type WorkspaceProjectEntry,
	type WorkspacesConfig,
	workspaceConfigPath,
} from "./workspace-store";
