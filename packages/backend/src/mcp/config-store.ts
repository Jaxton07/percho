import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isMcpServerOverride } from "@earendil-works/pi-mcp";
import {
	MCP_EXPOSURES,
	type McpConfigListResult,
	type McpExposure,
	type McpServerView,
	type McpTransportView,
	type McpUpsertInput,
} from "@percho/shared";
import { JsonStore } from "../json-store";
import { inspectMcpConfigs, validateMcpConfigs } from "./config-validation";

/**
 * `mcp.json` 读写（spec §4.8）：官方内置 mcp 扩展读这两个文件去连服务器，我们只做
 * **JSON 读写 + 形状校验 + 面板视图** —— 不实现连接、**不做环境变量展开**（官方负责）、不覆盖官方 `loadConfig`。
 *
 * 路径（与官方 cli 同款）：全局 `<agentDir>/mcp.json`；项目级 `<cwd>/.pi/mcp.json`（**仅受信项目读**）。
 *
 * 写路径的默认值（spec §4.8-1/-2）：
 * - 新增 server 且未指定 exposure → 写 `"deferred"`（官方默认是 codemode，要显式写才是 deferred）；
 * - **由我们创建** mcp.json 时，顶层写 `autoEnableCodemode: false`（不让官方自动激活 codemode）。
 */

const queues = new Map<string, Promise<void>>();
function serialize<T>(op: () => Promise<T>): Promise<T> {
	const key = globalMcpPath();
	const result = (queues.get(key) ?? Promise.resolve()).then(op, op);
	const settled = result.then(
		() => {},
		() => {},
	);
	queues.set(key, settled);
	void settled.then(() => {
		if (queues.get(key) === settled) queues.delete(key);
	});
	return result;
}
function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const EXPOSURES: ReadonlySet<string> = new Set(MCP_EXPOSURES);

interface McpFile {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
}

function parseMcpJson(raw: string): McpFile {
	return JSON.parse(raw.startsWith("\uFEFF") ? raw.slice(1) : raw) as McpFile;
}

function mcpStore(path: string): JsonStore<McpFile> {
	return new JsonStore<McpFile>({ path, defaultValue: () => ({}), parse: parseMcpJson });
}

export function globalMcpPath(): string {
	return join(getAgentDir(), "mcp.json");
}

export function projectMcpPath(cwd: string): string {
	return join(cwd, ".pi", "mcp.json");
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((v): v is string => typeof v === "string");
	return items.length === value.length ? items : undefined;
}

function transportOf(entry: Record<string, unknown>): McpTransportView {
	if (typeof entry.command === "string") {
		return { kind: "stdio", command: entry.command, args: asStringArray(entry.args) };
	}
	if (typeof entry.url === "string") return { kind: "url", url: entry.url };
	return { kind: "unknown" };
}

function exposureOf(value: unknown): McpExposure | undefined {
	return typeof value === "string" && EXPOSURES.has(value) ? (value as McpExposure) : undefined;
}

/** 逐工具 exposure 覆盖（原样呈现；非法值忽略） */
function toolExposureOf(value: unknown): Record<string, McpExposure> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, McpExposure> = {};
	for (const [tool, raw] of Object.entries(value as Record<string, unknown>)) {
		const exposure = exposureOf(raw);
		if (exposure)
			Object.defineProperty(out, tool, {
				value: exposure,
				enumerable: true,
				configurable: true,
				writable: true,
			});
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** 把一个 mcp.json 读成视图列表；保留原始档位，支持值与官方诊断分开呈现。 */
function toViews(raw: unknown, source: "user" | "project", errors: string[]): McpServerView[] {
	const servers = (raw as McpFile | null | undefined)?.mcpServers;
	if (servers === undefined) return [];
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		errors.push('mcpServers 必须是对象（形如 { "<name>": { "command": … } }）');
		return [];
	}
	const views: McpServerView[] = [];
	for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			const error = `server「${name}」的配置必须是对象`;
			errors.push(error);
			views.push({
				name,
				source,
				transport: { kind: "unknown" },
				enabled: true,
				exposure: "codemode",
				tools: [],
				error,
			});
			continue;
		}
		const entry = value as Record<string, unknown>;
		const exposureRaw = typeof entry.exposure === "string" ? entry.exposure : undefined;
		views.push({
			name,
			source,
			transport: transportOf(entry),
			description: typeof entry.description === "string" ? entry.description : undefined,
			enabled: entry.enabled !== false,
			exposureRaw,
			exposure: exposureOf(entry.exposure) ?? "codemode", // 非法原值另由官方校验报告，不当作支持档位。
			toolExposure: toolExposureOf(entry.toolExposure),
			tools: [],
		});
	}
	return views;
}

/**
 * 读一份 mcp.json：缺失 = 空配置（不报错）；**解析失败/形状错 → errors**（面板红字，不抛也不阻塞会话）。
 * 这条路径故意不用 `JsonStore.read()`：它的语义是「损坏就静默回退默认值 + warn」，而面板需要**看得见**原因。
 * 写路径仍走 JsonStore（tmp + rename 原子写）。
 */
async function readServersFile(
	path: string,
	source: "user" | "project",
	errors: string[],
	capture: (raw: unknown) => void,
): Promise<McpServerView[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return [];
		errors.push(`${path} 读取失败：${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
	let parsed: unknown;
	try {
		parsed = parseMcpJson(text);
	} catch (err) {
		errors.push(`${path} 解析失败：${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
	capture(parsed);
	return toViews(parsed, source, errors);
}

/** 列全局 + 项目级 server（项目级仅受信时读，与官方 trust-manager 同款） */
export async function listMcpServers(options: {
	cwd?: string;
	projectTrusted: boolean;
}): Promise<McpConfigListResult> {
	const errors: string[] = [];
	const globalPath = globalMcpPath();
	let globalRaw: unknown;
	let projectRaw: unknown;
	const global = await readServersFile(globalPath, "user", errors, (raw) => {
		globalRaw = raw;
	});
	const result: McpConfigListResult = {
		global,
		project: [],
		errors,
		projectTrusted: options.projectTrusted,
		globalPath,
	};
	if (options.cwd && options.projectTrusted) {
		const projectPath = projectMcpPath(options.cwd);
		result.projectPath = projectPath;
		result.project = await readServersFile(projectPath, "project", errors, (raw) => {
			projectRaw = raw;
		});
	}
	const inspection = inspectMcpConfigs(globalRaw, projectRaw);
	for (const view of result.project) view.overridesGlobal = inspection.overriddenGlobalNames.has(view.name);
	if (record(projectRaw) && record(projectRaw.mcpServers)) {
		for (const view of result.project) {
			const raw = projectRaw.mcpServers[view.name];
			const base = global.find((item) => item.name === view.name);
			if (
				record(raw) &&
				isMcpServerOverride(raw) &&
				base &&
				base.transport.kind !== "unknown" &&
				inspection.validGlobalNames.has(view.name)
			) {
				view.isOverride = true;
				view.transport = base.transport;
				view.enabled = typeof raw.enabled === "boolean" ? raw.enabled : base.enabled;
				view.exposure = exposureOf(view.exposureRaw) ?? base.exposure;
			}
		}
	}
	errors.push(...inspection.errors);
	return result;
}

/** 新增/编辑一个 server（source = scope）；返回写入后的列表（面板一次调用拿到新状态） */
export async function upsertMcpServer(
	input: McpUpsertInput,
	context: {
		projectTrusted: boolean;
	},
): Promise<McpConfigListResult> {
	const name = input.name;
	const hasCommand = typeof input.command === "string" && input.command.trim().length > 0;
	const hasUrl = typeof input.url === "string" && input.url.trim().length > 0;
	if (hasCommand && hasUrl) throw new Error("command（stdio）与 url（远程）只能填一个");
	if (input.scope === "project") {
		if (!input.cwd) throw new Error("项目级配置需要 cwd");
		if (!context.projectTrusted) throw new Error("项目未受信，不能写项目级 mcp.json");
	}
	return serialize(async () => {
		const path = input.scope === "project" ? projectMcpPath(input.cwd as string) : globalMcpPath();
		const store = mcpStore(path);
		const otherPath =
			input.scope === "project"
				? globalMcpPath()
				: input.cwd && context.projectTrusted
					? projectMcpPath(input.cwd)
					: undefined;
		const other = otherPath ? await mcpStore(otherPath).readStrict() : undefined;

		await store.update((draft) => {
			if (
				!draft ||
				typeof draft !== "object" ||
				Array.isArray(draft) ||
				(draft.mcpServers !== undefined &&
					(!draft.mcpServers || typeof draft.mcpServers !== "object" || Array.isArray(draft.mcpServers)))
			)
				throw new Error("mcpServers 必须是对象");
			// 由我们创建文件时带上官方的「别自动激活 codemode」开关（spec §4.8-2）
			if (draft.mcpServers === undefined && draft.autoEnableCodemode === undefined)
				draft.autoEnableCodemode = false;
			const servers = (draft.mcpServers ?? {}) as Record<string, unknown>;
			const existing = Object.hasOwn(servers, name) && record(servers[name]) ? servers[name] : {};
			const entry: Record<string, unknown> = { ...existing };
			if (hasCommand) {
				entry.command = (input.command as string).trim();
				if (input.args) entry.args = [...input.args];
				delete entry.url;
			} else if (hasUrl) {
				entry.url = (input.url as string).trim();
				delete entry.command;
				delete entry.args;
			} else if (existing.command === undefined && existing.url === undefined && input.scope !== "project") {
				throw new Error("新建 server 需要填 command（stdio）或 url（远程）");
			}
			if (input.description !== undefined) {
				const description = input.description.trim();
				if (description) entry.description = description;
				else delete entry.description;
			}
			if (input.enabled !== undefined) entry.enabled = input.enabled;
			// exposure：显式传就用它；新建（无现存 exposure）时写 deferred（spec §4.8-1）；编辑时不传则保持
			if (input.exposure !== undefined) entry.exposure = input.exposure;
			else if (
				entry.exposure === undefined &&
				!(
					input.scope === "project" &&
					!hasCommand &&
					!hasUrl &&
					existing.command === undefined &&
					existing.url === undefined
				)
			)
				entry.exposure = "deferred";
			Object.defineProperty(servers, name, {
				value: entry,
				enumerable: true,
				configurable: true,
				writable: true,
			});
			draft.mcpServers = servers;
			const errors =
				input.scope === "project" ? validateMcpConfigs(other, draft) : validateMcpConfigs(draft, other);
			if (errors.length) throw new Error(errors.join("\n"));
		});

		return listMcpServers({
			cwd: input.cwd,
			projectTrusted: context.projectTrusted,
		});
	});
}

/** 删除一个 server（按 name + scope）；文件不存在/条目不存在都算成功（幂等） */
export async function removeMcpServer(input: {
	scope: "user" | "project";
	cwd?: string;
	name: string;
	projectTrusted?: boolean;
}): Promise<void> {
	if (input.scope === "project" && !input.cwd) throw new Error("项目级配置需要 cwd");
	await serialize(async () => {
		const path = input.scope === "project" ? projectMcpPath(input.cwd as string) : globalMcpPath();
		const store = mcpStore(path);
		await store.update((draft) => {
			if (!record(draft) || (draft.mcpServers !== undefined && !record(draft.mcpServers)))
				throw new Error("mcpServers 必须是对象");
			// Removal is a repair operation: remaining legacy errors must not lock it out.
			if (record(draft.mcpServers)) delete draft.mcpServers[input.name];
		});
	});
}

/** Validate and merge an entire pasted batch before one atomic write. */
export async function importMcpServers(
	input: { json: string; cwd?: string },
	context: { projectTrusted: boolean },
): Promise<McpConfigListResult> {
	const parsed: unknown = parseMcpJson(input.json);
	if (!record(parsed)) throw new Error("导入配置必须是对象");
	const entries = Object.hasOwn(parsed, "mcpServers") ? parsed.mcpServers : parsed;
	if (!record(entries) || Object.keys(entries).length === 0) throw new Error("mcpServers 必须是非空对象");
	const importErrors = validateMcpConfigs({ mcpServers: entries });
	if (importErrors.length) throw new Error(importErrors.join("\n"));
	return serialize(async () => {
		const other =
			input.cwd && context.projectTrusted
				? await mcpStore(projectMcpPath(input.cwd)).readStrict()
				: undefined;
		const path = globalMcpPath();
		const exists = await stat(path).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		);
		const store = mcpStore(path);
		await store.update((draft) => {
			if (!record(draft) || (draft.mcpServers !== undefined && !record(draft.mcpServers)))
				throw new Error("mcpServers 必须是对象");
			const servers = { ...draft.mcpServers };
			for (const [name, raw] of Object.entries(entries)) {
				if (!record(raw)) throw new Error(`server「${name}」的配置必须是对象`);
				const existing = Object.hasOwn(servers, name) && record(servers[name]) ? servers[name] : {};
				const entry: Record<string, unknown> = { ...existing, ...raw };
				Object.defineProperty(servers, name, {
					value: entry,
					enumerable: true,
					configurable: true,
					writable: true,
				});
				if (entry.exposure === undefined) entry.exposure = "deferred";
			}
			if (!exists && draft.autoEnableCodemode === undefined) draft.autoEnableCodemode = false;
			draft.mcpServers = servers;
			const errors = validateMcpConfigs(draft, other);
			if (errors.length) throw new Error(errors.join("\n"));
		});
		return listMcpServers({ cwd: input.cwd, projectTrusted: context.projectTrusted });
	});
}
