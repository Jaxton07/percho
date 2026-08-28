export {
	JsonStore,
	JsonStoreCorruptedError,
	type JsonStoreOptions,
	type ReadResult,
} from "./json-store";
export { LanConfigService } from "./lan/config";
export {
	applyEvent as applyLanEvent,
	applyPermissionRequest as applyLanPermissionRequest,
	applyPermissionResolved as applyLanPermissionResolved,
	type LanPendingPermission,
	type LanSessionRuntime,
	seedView as seedLanView,
} from "./lan/projector";
export { type LanObserverBackend, LanObserverServer, type LanObserverServerOptions } from "./lan/server";
export { createLogger, initLogging, type Logger } from "./log";
export { fetchPackageCatalog, parseCatalogHtml } from "./packages/catalog";
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
} from "./permissions";
export {
	makePermissionGateExtension,
	type PermissionConfirm,
	type PermissionGateOptions,
} from "./permissions/extension";
export { PermissionGate, type PermissionRequestMeta, type PermissionResponder } from "./permissions/gate";
export { PiBackend, type PiBackendOptions } from "./pi-backend";
export {
	buildTrustOptions,
	type ResolveTrustOptions,
	resolveProjectTrust,
	TrustGate,
	type TrustOptionInternal,
	type TrustResponder,
} from "./project/trust";
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
} from "./project/workspace-store";
export {
	assignEntryIds,
	blockImages,
	blockText,
	type ContentBlock,
	type RawMessage,
	resolveForkEntryId,
	resolveRecallEntryId,
	toSessionMessages,
} from "./session/messages";
export { type RegisteredSession, SessionRegistry } from "./session/registry";
export { TraceRecorder } from "./session/trace";
export { LoginService, type LoginServiceDeps } from "./settings/login";
export { ModelPrefsService } from "./settings/model-prefs";
export { SettingsService } from "./settings/settings";
export { BUILTIN_SLASH_COMMANDS, slashCommandsForLoader, slashCommandsForSession } from "./slash-commands";
export { makeShowImageTool, resolveShowImagePath, type ShowImageDetails } from "./tools/show-image";
export { formatTodoList, makeTodoTool, normalizeTodos } from "./tools/todo";
export { makeTodoReminderExtension } from "./tools/todo-reminder";
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
} from "./tools/webfetch";
