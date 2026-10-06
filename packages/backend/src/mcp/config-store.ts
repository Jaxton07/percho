import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	McpConfigListResult,
	McpExposure,
	McpServerView,
	McpTransportView,
	McpUpsertInput,
} from "@percho/shared";
import { JsonStore } from "../json-store";

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

const EXPOSURES: ReadonlySet<string> = new Set(["direct", "model-only", "codemode", "deferred", "hidden"]);

interface McpFile {
	mcpServers?: Record<string, unknown>;
	[key: string]: unknown;
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
		if (exposure) out[tool] = exposure;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** 把一个 mcp.json 读成视图列表（含**有效 exposure**：exposureRaw ?? "codemode"） */
function toViews(
	raw: unknown,
	source: "user" | "project",
	errors: string[],
	toolsByServer: Map<string, string[]>,
): McpServerView[] {
	const servers = (raw as McpFile | null | undefined)?.mcpServers;
	if (servers === undefined) return [];
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		errors.push('mcpServers 必须是对象（形如 { "<name>": { "command": … } }）');
		return [];
	}
	const views: McpServerView[] = [];
	for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			errors.push(`server「${name}」的配置必须是对象`);
			continue;
		}
		const entry = value as Record<string, unknown>;
		const exposureRaw = exposureOf(entry.exposure);
		views.push({
			name,
			source,
			transport: transportOf(entry),
			description: typeof entry.description === "string" ? entry.description : undefined,
			enabled: entry.enabled !== false,
			exposureRaw,
			exposure: exposureRaw ?? "codemode", // 官方默认（core/mcp-servers.js: config.exposure ?? "codemode"）
			toolExposure: toolExposureOf(entry.toolExposure),
			tools: toolsByServer.get(name) ?? [],
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
	toolsByServer: Map<string, string[]>,
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
		parsed = JSON.parse(text);
	} catch (err) {
		errors.push(`${path} 解析失败：${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
	return toViews(parsed, source, errors, toolsByServer);
}

/** 列全局 + 项目级 server（项目级仅受信时读，与官方 trust-manager 同款） */
export async function listMcpServers(options: {
	cwd?: string;
	projectTrusted: boolean;
	toolsByServer?: Map<string, string[]>;
}): Promise<McpConfigListResult> {
	const errors: string[] = [];
	const tools = options.toolsByServer ?? new Map<string, string[]>();
	const globalPath = globalMcpPath();
	const global = await readServersFile(globalPath, "user", errors, tools);
	const result: McpConfigListResult = {
		global,
		project: [],
		errors,
		projectTrusted: options.projectTrusted,
		globalPath,
	};
	if (!options.cwd || !options.projectTrusted) return result;
	const projectPath = projectMcpPath(options.cwd);
	result.projectPath = projectPath;
	result.project = await readServersFile(projectPath, "project", errors, tools);
	return result;
}

/** 新增/编辑一个 server（source = scope）；返回写入后的列表（面板一次调用拿到新状态） */
export async function upsertMcpServer(
	input: McpUpsertInput,
	context: { projectTrusted: boolean; toolsByServer?: Map<string, string[]> },
): Promise<McpConfigListResult> {
	const name = input.name.trim();
	if (!name) throw new Error("Server 名称不能为空");
	if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Server 名称只能包含字母、数字、.、_、-");
	const hasCommand = typeof input.command === "string" && input.command.trim().length > 0;
	const hasUrl = typeof input.url === "string" && input.url.trim().length > 0;
	if (hasCommand && hasUrl) throw new Error("command（stdio）与 url（远程）只能填一个");
	if (input.scope === "project") {
		if (!input.cwd) throw new Error("项目级配置需要 cwd");
		if (!context.projectTrusted) throw new Error("项目未受信，不能写项目级 mcp.json");
	}
	const path = input.scope === "project" ? projectMcpPath(input.cwd as string) : globalMcpPath();
	const store = new JsonStore<McpFile>({ path, defaultValue: () => ({}) });

	await store.update((draft) => {
		// 由我们创建文件时带上官方的「别自动激活 codemode」开关（spec §4.8-2）
		if (draft.mcpServers === undefined && draft.autoEnableCodemode === undefined)
			draft.autoEnableCodemode = false;
		const servers = (draft.mcpServers ?? {}) as Record<string, unknown>;
		const existing = (servers[name] as Record<string, unknown> | undefined) ?? {};
		const entry: Record<string, unknown> = { ...existing };
		if (hasCommand) {
			entry.command = (input.command as string).trim();
			if (input.args) entry.args = [...input.args];
			delete entry.url;
		} else if (hasUrl) {
			entry.url = (input.url as string).trim();
			delete entry.command;
			delete entry.args;
		} else if (existing.command === undefined && existing.url === undefined) {
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
		else if (entry.exposure === undefined) entry.exposure = "deferred";
		servers[name] = entry;
		draft.mcpServers = servers;
	});

	return listMcpServers({
		cwd: input.cwd,
		projectTrusted: context.projectTrusted,
		toolsByServer: context.toolsByServer,
	});
}

/** 删除一个 server（按 name + scope）；文件不存在/条目不存在都算成功（幂等） */
export async function removeMcpServer(input: {
	scope: "user" | "project";
	cwd?: string;
	name: string;
}): Promise<void> {
	const path = input.scope === "project" && input.cwd ? projectMcpPath(input.cwd) : globalMcpPath();
	const store = new JsonStore<McpFile>({ path, defaultValue: () => ({}) });
	await store.update((draft) => {
		const servers = (draft.mcpServers ?? {}) as Record<string, unknown>;
		delete servers[input.name];
		draft.mcpServers = servers;
	});
}
