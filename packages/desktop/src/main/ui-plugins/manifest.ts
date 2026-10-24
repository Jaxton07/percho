import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@percho/backend";
import {
	KNOWN_UI_REGIONS,
	KNOWN_UI_SLOTS,
	UI_PLUGIN_ANCHORS,
	type UiPluginContribution,
	type UiPluginManifest,
} from "@percho/shared";
import { isSettingValue, SETTING_KEY_RE } from "./settings";

const log = createLogger("ui-plugins");

export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAIN_RE = /\.(ts|tsx|js|jsx)$/;
const CONTRIBUTION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** manifest 校验（spec §5 + §16）：任一不满足 → 返回原因，插件标记 invalid 不参与加载 */
export function validateManifest(dirName: string, m: Partial<UiPluginManifest>): string | null {
	if (!m || typeof m !== "object") return "plugin.json 缺失或损坏";
	if (typeof m.name !== "string" || !NAME_RE.test(m.name) || m.name !== dirName) {
		return `name 非法（须匹配 ${NAME_RE.source} 且与目录名一致）`;
	}
	if (m.perchoUi !== 1 && m.perchoUi !== 2) return "perchoUi 版本不匹配（接受 1 / 2）";
	const v2 = m.perchoUi === 2;
	if (typeof m.main !== "string" || m.main.includes("..") || !MAIN_RE.test(m.main)) {
		return "main 非法（须为目录内相对路径，禁止 .. 穿越，后缀 .ts/.tsx/.js/.jsx）";
	}
	// slots / contributions / headless 至少其一非空（spec §11/§16：无头插件无组件）
	const slotsOk = !!m.slots && typeof m.slots === "object" && Object.keys(m.slots).length > 0;
	if (m.contributions !== undefined && !Array.isArray(m.contributions)) {
		return "contributions 必须是数组";
	}
	if (!slotsOk && (m.contributions?.length ?? 0) === 0 && m.headless !== true) {
		return "slots / contributions / headless 至少其一非空";
	}
	if (slotsOk) {
		for (const [slot, exportName] of Object.entries(m.slots ?? {})) {
			if (!KNOWN_UI_SLOTS.includes(slot)) return `槽位 ${slot} 未知`;
			if (typeof exportName !== "string" || exportName.length === 0) return `槽位 ${slot} 的导出名非法`;
		}
	}
	// v2 新增字段：v1 插件声明了也不判 invalid，只告警并忽略（契约按版本生效，spec §5）
	if (!v2) {
		if (m.styles !== undefined || m.settingsSchema !== undefined) {
			log.warn("perchoUi=1 不支持 styles / settingsSchema，已忽略（需要 perchoUi: 2）");
		}
	} else {
		const stylesError = validateStyles(m.styles);
		if (stylesError) return stylesError;
		const schemaError = validateSettingsSchema(m.settingsSchema);
		if (schemaError) return schemaError;
	}
	// contributions 逐条校验；未知 region 校验报警告并忽略该条（不判 invalid，spec §16 版本前瞻）
	const seenIds = new Set<string>();
	for (const c of m.contributions ?? []) {
		if (!c || typeof c !== "object") return "contributions 条目非法";
		if (typeof c.region !== "string" || !KNOWN_UI_REGIONS.includes(c.region)) {
			log.warn(`manifest contribution 忽略未知 region:`, JSON.stringify(c));
			continue; // 未知 region 条目整体跳过（含其 id/export，宿主无从校验新契约）
		}
		if (typeof c.id !== "string" || !CONTRIBUTION_ID_RE.test(c.id)) {
			return `contribution ${String(c.id)} 的 id 非法（须匹配 ${CONTRIBUTION_ID_RE.source}）`;
		}
		if (seenIds.has(c.id)) return `contribution id 重复：${c.id}`;
		seenIds.add(c.id);
		if (typeof c.export !== "string" || c.export.length === 0) {
			return `contribution ${c.id} 的 export 非法`;
		}
		if (
			c.anchor !== undefined &&
			!UI_PLUGIN_ANCHORS.includes(c.anchor as (typeof UI_PLUGIN_ANCHORS)[number])
		) {
			return `contribution ${c.id} 的 anchor 非法（须为九宫格枚举）`;
		}
		if (v2) {
			if (c.layout !== undefined && c.layout !== "form" && c.layout !== "full") {
				return `contribution ${c.id} 的 layout 非法（form / full）`;
			}
			if (c.isolation !== undefined && c.isolation !== "light" && c.isolation !== "shadow") {
				return `contribution ${c.id} 的 isolation 非法（light / shadow）`;
			}
		}
	}
	return null;
}

/** styles：目录内相对路径的 .css 列表（≤ 8 个，禁 .. 穿越与绝对路径） */
function validateStyles(styles: unknown): string | null {
	if (styles === undefined) return null;
	if (!Array.isArray(styles)) return "styles 必须是数组";
	if (styles.length > 8) return "styles 最多 8 个文件";
	for (const s of styles) {
		if (typeof s !== "string" || s.length === 0) return "styles 条目非法";
		if (s.includes("..") || s.startsWith("/") || s.includes("\\")) return `styles 路径非法：${s}`;
		if (!/\.css$/i.test(s)) return `styles 只接受 .css：${s}`;
	}
	return null;
}

const SETTING_FIELD_TYPES = ["boolean", "string", "number", "select"] as const;
const TEXT_RE_OK = (v: unknown) =>
	typeof v === "string"
		? v.length > 0 && v.length <= 200
		: !!v &&
			typeof v === "object" &&
			typeof (v as { zh?: unknown }).zh === "string" &&
			typeof (v as { en?: unknown }).en === "string";

/**
 * settingsSchema.migrations：声明式迁移脚本。
 * 只做数据变换，所以能静态校验到"每一步只有 rename/drop/set 三个动作"。
 */
function validateMigrations(migrations: unknown): string | null {
	if (migrations === undefined) return null;
	if (!migrations || typeof migrations !== "object" || Array.isArray(migrations)) {
		return "settingsSchema.migrations 必须是对象";
	}
	const steps = Object.entries(migrations as Record<string, unknown>);
	if (steps.length > 16) return "settingsSchema.migrations 最多 16 步";
	for (const [from, raw] of steps) {
		if (!/^\d{1,6}$/.test(from)) return `settingsSchema.migrations 的键必须是目标版本号：${from}`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return `settingsSchema.migrations["${from}"] 必须是对象`;
		}
		const step = raw as { rename?: unknown; drop?: unknown; set?: unknown };
		if (step.rename !== undefined) {
			if (!step.rename || typeof step.rename !== "object" || Array.isArray(step.rename)) {
				return `settingsSchema.migrations["${from}"].rename 必须是对象`;
			}
			const pairs = Object.entries(step.rename as Record<string, unknown>);
			if (pairs.length > 32) return `settingsSchema.migrations["${from}"].rename 最多 32 项`;
			for (const [key, to] of pairs) {
				if (!SETTING_KEY_RE.test(key)) return `迁移源键名非法：${key}`;
				if (typeof to !== "string" || !SETTING_KEY_RE.test(to)) return `迁移目标键名非法：${String(to)}`;
			}
		}
		if (step.drop !== undefined) {
			if (!Array.isArray(step.drop) || step.drop.length > 32) {
				return `settingsSchema.migrations["${from}"].drop 必须是不超过 32 项的数组`;
			}
			for (const key of step.drop) {
				if (typeof key !== "string" || !SETTING_KEY_RE.test(key)) return `迁移删除键名非法：${String(key)}`;
			}
		}
		if (step.set !== undefined) {
			if (!step.set || typeof step.set !== "object" || Array.isArray(step.set)) {
				return `settingsSchema.migrations["${from}"].set 必须是对象`;
			}
			const pairs = Object.entries(step.set as Record<string, unknown>);
			if (pairs.length > 32) return `settingsSchema.migrations["${from}"].set 最多 32 项`;
			for (const [key, value] of pairs) {
				if (!SETTING_KEY_RE.test(key)) return `迁移补写键名非法：${key}`;
				if (!isSettingValue(value)) return `迁移补写值非法：${key}`;
			}
		}
	}
	return null;
}

/** settingsSchema：声明式设置表，宿主据此自动生成设置页 */
function validateSettingsSchema(schema: unknown): string | null {
	if (schema === undefined) return null;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return "settingsSchema 必须是对象";
	const s = schema as { version?: unknown; fields?: unknown; migrations?: unknown };
	if (s.version !== undefined && (typeof s.version !== "number" || !Number.isFinite(s.version))) {
		return "settingsSchema.version 必须是数字";
	}
	const migrationError = validateMigrations(s.migrations);
	if (migrationError) return migrationError;
	if (!s.fields || typeof s.fields !== "object" || Array.isArray(s.fields)) {
		return "settingsSchema.fields 必须是对象";
	}
	const entries = Object.entries(s.fields as Record<string, unknown>);
	if (entries.length > 32) return "settingsSchema.fields 最多 32 项";
	for (const [key, raw] of entries) {
		if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return `settingsSchema 键名非法：${key}`;
		if (!raw || typeof raw !== "object") return `settingsSchema.${key} 必须是对象`;
		const f = raw as Record<string, unknown>;
		if (!SETTING_FIELD_TYPES.includes(f.type as (typeof SETTING_FIELD_TYPES)[number])) {
			return `settingsSchema.${key}.type 非法（boolean / string / number / select）`;
		}
		if (!TEXT_RE_OK(f.label)) return `settingsSchema.${key}.label 非法（字符串或 {zh,en}）`;
		if (f.hint !== undefined && !TEXT_RE_OK(f.hint)) return `settingsSchema.${key}.hint 非法`;
		if (f.type === "select") {
			if (!Array.isArray(f.options) || f.options.length === 0) {
				return `settingsSchema.${key}.options 必须是非空数组`;
			}
			for (const opt of f.options as unknown[]) {
				if (!opt || typeof opt !== "object") return `settingsSchema.${key}.options 条目非法`;
				const o = opt as Record<string, unknown>;
				if (typeof o.value !== "string" || !TEXT_RE_OK(o.label)) {
					return `settingsSchema.${key}.options 条目需要 {value, label}`;
				}
			}
		}
	}
	return null;
}

/**
 * 过滤 contributions：剔除未知 region 条目（scanAll 合成 info 与 readCode 返回的 manifest 都用这份），
 * 并把非 app.overlay 区域的 anchor 剥离（anchor 仅对 overlay 有意义）。
 * 非数组输入（坏插件可能给任意形状）一律空，防上层 for...of/条目访问抛错。
 */
export function filterContributions(
	contributions: UiPluginContribution[] | undefined,
	perchoUi: number = 2,
): UiPluginContribution[] {
	if (!Array.isArray(contributions)) return [];
	const out: UiPluginContribution[] = [];
	for (const c of contributions) {
		if (!c || typeof c.region !== "string" || !KNOWN_UI_REGIONS.includes(c.region)) continue;
		const next: UiPluginContribution = c.region === "app.overlay" ? { ...c } : { ...c, anchor: undefined };
		// v1 契约里没有 layout / isolation：剥掉，避免老插件被按新语义渲染
		if (perchoUi < 2) {
			next.layout = undefined;
			next.isolation = undefined;
		}
		out.push(next);
	}
	return out;
}

/** 读插件目录下的 plugin.json；解析失败返回 null */
export async function readManifest(dir: string): Promise<Partial<UiPluginManifest> | null> {
	try {
		const raw = await readFile(join(dir, "plugin.json"), "utf-8");
		return JSON.parse(raw) as Partial<UiPluginManifest>;
	} catch {
		return null;
	}
}
