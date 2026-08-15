/**
 * 逐工具权限规则引擎 barrel：实现拆在本目录三模块，入口 = permissions/index.ts（原 permission-rules.ts）。
 * - bash-chain.ts  bash 命令链解析（切段/替换提取/包装剥壳/候选收集）
 * - pattern.ts     规则求值 + 通配匹配 + 模式键建议（含 PermissionAction/Rule/Rules/Outside 类型）
 * - config.ts      permissions.json 读写 + 默认配置（含 PermissionConfig 类型）
 */
export {
	collectBashCandidates,
	extractShellExecArg,
	extractSubstitutions,
	splitShellSegments,
} from "./bash-chain";
export {
	createPermissionConfigLoader,
	DEFAULT_PERMISSION_CONFIG,
	loadPermissionConfig,
	mergeWithDefaults,
	type PermissionConfig,
	permissionConfigPath,
	setPermissionEnabled,
} from "./config";
export {
	evaluateBashCommand,
	evaluateRules,
	matchPattern,
	matchTextFor,
	type PermissionAction,
	type PermissionOutside,
	type PermissionRule,
	type PermissionRules,
	patternMatchesToolCall,
	suggestPattern,
} from "./pattern";
