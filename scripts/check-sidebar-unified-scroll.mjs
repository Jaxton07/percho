#!/usr/bin/env node
/**
 * 左栏「统一滚动 + 每组 6 条分批显示」CDP 验收（spec: sidebar-unified-scroll）
 *
 * 前置：dev 应用带调试端口运行、左栏处于展开状态
 *   cd packages/desktop && npx electron-vite dev -- --remote-debugging-port=9224
 *   （`npm run dev -- --remote-debugging-port=9224` 不行：npm 会把参数吞掉）
 *
 * 用法：
 *   node scripts/check-sidebar-unified-scroll.mjs             # 跑断言（CDP_PORT 可换端口）
 *   node scripts/check-sidebar-unified-scroll.mjs --seed      # 写入 dev 样本（**先停 dev**）
 *   node scripts/check-sidebar-unified-scroll.mjs --clean     # 删掉样本（**先停 dev**）
 *   node scripts/check-sidebar-unified-scroll.mjs --selftest  # 每轮新建唯一隔离根，验样本的创建/清理保护
 * 退出码：0 成功 / 1 断言失败、脚本异常或**安全拒绝删改** / 2 环境不满足（无法判定，见提示）
 *
 * 为什么要样本：① 6 / 22 / 38 三档要在一个 **≥ 39 条会话**的组上才验证得了（38 是全档、不是被总数截断）；
 * ② 「搜索前折叠 → 搜索命中临时展开 → 换词/清空还原」需要一个**确定存在且可搜**的第二组（不靠日常组碰运气）。
 * 所以 `--seed` 在隔离的 dev agent dir（`~/.percho/agent-dev`，正式目录零写入）造两组样本会话：
 * 主组 `SAMPLE_COUNT` 条（跨三档，断言里会真实打开它最旧的一条来验「active 越界」）+ 副组 `SAMPLE_SECOND_COUNT` 条
 * （搜索换词用），外加两个样本项目目录与 dev trust.json 的对应条目。会话目录只在应用启动时读一次 →
 * seed/clean 后要重启 dev；用完请 `--clean`（样本缺失时断言部分会直接报退出码 2，不会假绿）。
 *
 * 样本的创建/清理是 **fail-closed** 的（见下方「样本」段的纪律）：不是自己签名创建的目录、文件或 trust 键，
 * 一律拒绝删改；`--selftest` 把每一条保护都在**每轮用 mkdtemp 新建的唯一隔离根**上跑一遍
 * （跑完自清；固定名 `.local/tmp/check-sidebar-sample-selftest*` 下的既有内容只作为「不许被删」的反例被检查，
 * 不碰 `~/.percho/agent-dev` 与任何正式目录）。
 *
 * 纪律（沿用旧脚本，见 docs/PITFALLS.md「嵌套滚动的归属验证」）：
 * - 用 **CDP 真实 wheel**（`Input.dispatchMouseEvent` type=mouseWheel）验证滚动归属，
 *   不拿直接赋 scrollTop 冒充滚动（赋 scrollTop/`scrollIntoView` 只用于把目标预置到可视位置）；
 * - 手势落点必须真的在目标上且不被浮层遮挡（`elementFromPoint` 自检）；
 * - 读数前等滚动落定（连续两次读数相同）；
 * - 定位只走 `data-*` 与 DOM 关系，不按 UI 文案匹配（样本组 key 是 cwd，来自数据；搜索词取自会话标题数据）；
 * - 结束时复位主体 scrollTop 与搜索框（会真实展开/折叠分组、点「显示更多」，即会改动 dev 的 ui-state 展开偏好）。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（`--selftest` 的隔离根放在 `.local/tmp/`，不进 /tmp 也不进正式目录） */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_ENV = 2;

/* ---------- 与源码同步的常量（改实现要同步这里：这是验收口径） ---------- */
/** 与 lib/sidebar-visible-count.ts 的 SIDEBAR_GROUP_INITIAL_ROWS / SIDEBAR_GROUP_MORE_STEP 一致 */
const INITIAL_ROWS = 6;
const MORE_STEP = 16;
/** 与 SessionRow 的 h-[31px] / ProjectRow 的 h-[34px] 一致 */
const ROW_HEIGHT = 31;
const TITLE_HEIGHT = 34;

/* ---------- 样本：路径推导、清单、fail-closed 的创建 / 清理 ----------
 *
 * 纪律（review 阻断 1 的要求）：**只碰自己签名创建的东西，任何意外一律拒绝执行（fail-closed）**
 * - 创建前：清单不存在 + 样本目录全不存在 + trust.json 能解析且样本 cwd 无既有条目，缺一条就拒绝；
 * - 清理前：先**全部核验**（清单 kind/version 与路径必须和本地推导逐字一致、目录内容只认样本文件与 traces、
 *   项目目录必须为空、trust 值必须仍是我们写下的 true），任何一条不满足就**什么都不删**并报错；
 * - 目录/文件的探测只把 ENOENT 当「不存在」，其它错误（权限等）一律抛出，不吞错；
 * - 删除清单放最后：中途崩了还能重跑清理；
 * - `--selftest` 在 `.local/tmp/` 的隔离根上把上述保护逐条跑一遍（**不碰正式目录与 dev agent dir**）。
 */
/**
 * 打开样本会话后，**应用自己**会在该项目 cwd 里初始化这套目录（channel-watch 的目录协议，见
 * `tools/channel-watch/init.ts`：`.local/agent-work/{channel,spec,plan}`）。所以样本项目目录在用过之后
 * 不会是空的 —— 清理时**只认这套空目录**：顶层只允 `.local`，其下只允清单里这几个目录名，且**一个文件都不许有**；
 * 出现任何别的条目（文件、陌生目录、符号链接）一律拒绝删除。应用将来多建一级就会拒绝 → 人工确认，fail-closed。
 */
const APP_SCAFFOLD_TOP = ".local";
const APP_SCAFFOLD_DIRS = [APP_SCAFFOLD_TOP, join(APP_SCAFFOLD_TOP, "agent-work")];
for (const leaf of ["channel", "plan", "spec"])
	APP_SCAFFOLD_DIRS.push(join(APP_SCAFFOLD_TOP, "agent-work", leaf));

const SAMPLE_KIND = "percho/sidebar-unified-scroll-sample";
const SAMPLE_VERSION = 1;
const MANIFEST_NAME = ".percho-check-sample.json";
const SAMPLES_DIR_NAME = "dev-samples";
/** 样本组：主组要跨 6/22/38 三档；副组是「搜索换词 / 临时展开」断言的确定性对照（不再靠日常组碰运气） */
const SAMPLE_GROUPS = [
	{
		label: "主样本组",
		count: 45,
		idPrefix: "01a1a1a1-1111-7111-8111-",
		namePrefix: "样本会话",
		dirName: "sidebar-unified-scroll-sample",
	},
	{
		label: "副样本组",
		count: 9,
		idPrefix: "01a2b2b2-2222-7222-8222-",
		namePrefix: "样本二组",
		dirName: "sidebar-second-sample",
	},
];
const SAMPLE_COUNT = SAMPLE_GROUPS[0].count;
const SAMPLE_NAME_PREFIX = SAMPLE_GROUPS[0].namePrefix;
const SAMPLE_SECOND_COUNT = SAMPLE_GROUPS[1].count;
const SAMPLE_SECOND_NAME_PREFIX = SAMPLE_GROUPS[1].namePrefix;

/** 真实 dev 路径（`~/.percho/agent-dev`：隔离目录，正式 agent dir 零写入） */
const DEV_PATHS = {
	agentDir: process.env.PERCHO_AGENT_DIR ?? join(homedir(), ".percho", "agent-dev"),
	sessionsRoot: join(process.env.PERCHO_AGENT_DIR ?? join(homedir(), ".percho", "agent-dev"), "sessions"),
	trustFile: join(process.env.PERCHO_AGENT_DIR ?? join(homedir(), ".percho", "agent-dev"), "trust.json"),
};

/** 会话目录名与 SDK 同口径：`--` + 去掉前导斜杠 + `/\:` 换 `-` + `--` */
const sessionDirFor = (sessionsRoot, cwd) =>
	join(sessionsRoot, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

/** 由 agentDir 推导样本的全部路径。清理时会用同一套推导核对清单，篡改过的清单对不上就直接拒绝 */
function sampleSpec(paths) {
	const parent = join(paths.agentDir, SAMPLES_DIR_NAME);
	const projectDirs = SAMPLE_GROUPS.map((group) => join(parent, group.dirName));
	return {
		paths,
		parent,
		projectDirs,
		sessionDirs: projectDirs.map((cwd) => sessionDirFor(paths.sessionsRoot, cwd)),
		manifestFile: join(parent, MANIFEST_NAME),
	};
}

/** 拒绝执行（fail-closed）：消息面向人，讲清拒绝原因与下一步 */
class SampleError extends Error {}

/** 只把 ENOENT 当「不存在」；权限等其它错误照抛（别把探测失败当目录不存在） */
async function statOrNull(path) {
	try {
		return await stat(path);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

async function readdirOrNull(path) {
	try {
		return await readdir(path);
	} catch (err) {
		if (err.code === "ENOENT") return null;
		throw err;
	}
}

/** 读 JSON：不存在 → null；解析失败 → 拒绝执行（不猜测内容） */
async function readJsonOrNull(path) {
	const text = await readFile(path, "utf8").catch((err) => {
		if (err.code === "ENOENT") return null;
		throw err;
	});
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new SampleError(`读不出 JSON（${path}）：${err.message}`);
	}
}

const sameStrings = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * 递归列出应用脚手架（`<projectDir>/.local`）里不属于允许集合的条目（任何文件、陌生目录、符号链接都算）。
 * 相对路径以**项目目录**为基准，与 `APP_SCAFFOLD_DIRS` 同口径。fail-closed 用
 */
async function findForeignScaffoldEntries(projectDir, allowedDirs) {
	const allowed = new Set(allowedDirs);
	const foreign = [];
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const rel = relative(projectDir, full);
			if (!entry.isDirectory()) {
				foreign.push(`${rel}（非目录）`);
				continue;
			}
			if (!allowed.has(rel)) {
				foreign.push(`${rel}（陌生目录）`);
				continue;
			}
			await walk(full);
		}
	};
	await walk(join(projectDir, APP_SCAFFOLD_TOP));
	return foreign;
}

/** 会话文件里的 entry id：8 位十六进制（与真实文件同形） */
const entryId = (n) => n.toString(16).padStart(8, "0");

/**
 * 写入样本（**只在自己签名之后动手**）。顺序：核验 → 落清单（声明拥有这些路径）→ 建目录写会话 → 写 trust。
 * 清单先落，中途崩了也能被 `--clean` 认出并收掉。
 */
async function seedSample(spec) {
	const { paths, parent, projectDirs, sessionDirs, manifestFile } = spec;

	if (await statOrNull(manifestFile)) {
		throw new SampleError(
			`样本清单已存在（${manifestFile}）：已 seed 过或上次没清干净，先 --clean（或人工确认后删除）`,
		);
	}
	for (const dir of [...projectDirs, ...sessionDirs]) {
		if (await statOrNull(dir)) {
			throw new SampleError(`样本路径已存在（${dir}）：拒绝写进既有目录，人工确认后再处理`);
		}
	}
	const trust = (await readJsonOrNull(paths.trustFile)) ?? {};
	if (typeof trust !== "object" || trust === null || Array.isArray(trust)) {
		throw new SampleError(`trust.json 不是对象（${paths.trustFile}）：拒绝改写`);
	}
	for (const cwd of projectDirs) {
		if (Object.hasOwn(trust, cwd)) {
			throw new SampleError(
				`trust.json 里已有样本 cwd 的条目（${cwd}）：拒绝覆盖既有决定，人工确认后删除该键再 seed`,
			);
		}
	}

	await mkdir(parent, { recursive: true });
	await writeFile(
		manifestFile,
		`${JSON.stringify(
			{
				kind: SAMPLE_KIND,
				version: SAMPLE_VERSION,
				createdAt: new Date().toISOString(),
				projectDirs,
				sessionDirs,
				appScaffold: [APP_SCAFFOLD_TOP],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	for (const [index, group] of SAMPLE_GROUPS.entries()) {
		const cwd = projectDirs[index];
		await mkdir(cwd, { recursive: true });
		await mkdir(sessionDirs[index], { recursive: true });
		const base = Date.now() - group.count * 60_000;
		for (let i = 1; i <= group.count; i++) {
			const id = `${group.idPrefix}${String(i).padStart(12, "0")}`;
			const activity = base + i * 60_000; // 越靠后越新 → 列表里 01 最旧、最后一条最新
			const iso = new Date(activity).toISOString();
			const name = `${group.namePrefix} ${String(i).padStart(2, "0")}`;
			const lines = [
				{ type: "session", version: 3, id, timestamp: iso, cwd },
				{ type: "session_info", id: entryId(1), parentId: null, timestamp: iso, name },
				{
					type: "message",
					id: entryId(2),
					parentId: entryId(1),
					timestamp: iso,
					message: {
						role: "user",
						content: [{ type: "text", text: `${name}：这是左栏验收用的样本提问。` }],
						timestamp: activity,
					},
				},
				{
					type: "message",
					id: entryId(3),
					parentId: entryId(2),
					timestamp: iso,
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${name}：样本回答。` }],
						timestamp: activity + 1,
					},
				},
			];
			await writeFile(
				join(sessionDirs[index], `${iso.replace(/[:.]/g, "-")}_${id}.jsonl`),
				`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
				"utf8",
			);
		}
	}

	// 信任：断言阶段要真实打开一条主样本会话（验证「active 越界不破例」），未信任会弹信任弹窗挡住后续断言
	const next = { ...trust };
	for (const cwd of projectDirs) next[cwd] = true;
	await writeFile(paths.trustFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");

	return { projectDirs, sessionDirs, counts: SAMPLE_GROUPS.map((group) => group.count) };
}

/**
 * 清理样本：**先把能删的东西全部核验完，再动手**。任何意外都拒绝并保持原样。
 * 返回 `{ removed }`；没有样本且没有残留时是幂等的 no-op。
 */
async function cleanSample(spec) {
	const { paths, parent, projectDirs, sessionDirs, manifestFile } = spec;
	const manifest = await readJsonOrNull(manifestFile);
	const existing = [];
	for (const dir of [...projectDirs, ...sessionDirs]) {
		if (await statOrNull(dir)) existing.push(dir);
	}
	if (manifest === null) {
		if (existing.length > 0) {
			throw new SampleError(
				`没有样本清单（${manifestFile}）却存在样本路径：无法证明是本脚本创建的，拒绝删除。人工确认后可自行删除：${existing.join(", ")}`,
			);
		}
		return { removed: false };
	}
	if (manifest.kind !== SAMPLE_KIND || manifest.version !== SAMPLE_VERSION) {
		throw new SampleError(`样本清单 kind/version 不匹配（${manifestFile}）：拒绝删除`);
	}
	if (!sameStrings(manifest.projectDirs, projectDirs) || !sameStrings(manifest.sessionDirs, sessionDirs)) {
		throw new SampleError(`样本清单里的路径与本地推导不一致（${manifestFile}）：清单可能被篡改，拒绝删除`);
	}
	if (!sameStrings(manifest.appScaffold, [APP_SCAFFOLD_TOP])) {
		throw new SampleError(`样本清单里的 appScaffold 与本地约定不一致（${manifestFile}）：拒绝删除`);
	}

	// 逐目录核验内容：只认样本会话文件 + traces/，其它一概拒绝
	for (const [index, dir] of sessionDirs.entries()) {
		const entries = await readdirOrNull(dir);
		if (entries === null) continue; // 已被部分清理过：没有就跳过
		const prefix = SAMPLE_GROUPS[index].idPrefix;
		const foreign = entries.filter((name) => name !== "traces" && !name.includes(prefix));
		if (foreign.length > 0) {
			throw new SampleError(`样本会话目录里有陌生条目（${dir}）：${foreign.join(", ")} → 拒绝删除任何东西`);
		}
		if (entries.includes("traces")) {
			const traces = await readdirOrNull(join(dir, "traces"));
			const traceForeign = (traces ?? []).filter((name) => !name.includes(prefix));
			if (traceForeign.length > 0) {
				throw new SampleError(
					`样本 traces 目录里有非样本文件（${join(dir, "traces")}）：${traceForeign.join(", ")} → 拒绝删除`,
				);
			}
		}
	}
	for (const dir of projectDirs) {
		const entries = await readdirOrNull(dir);
		if (entries === null) continue;
		// 顶层只允许应用脚手架那一个目录名（正常打开过样本会话就会有）
		const foreignTop = entries.filter((name) => name !== APP_SCAFFOLD_TOP);
		if (foreignTop.length > 0) {
			throw new SampleError(`样本项目目录里有陌生条目（${dir}）：${foreignTop.join(", ")} → 拒绝删除`);
		}
		if (entries.includes(APP_SCAFFOLD_TOP)) {
			const scaffoldDir = join(dir, APP_SCAFFOLD_TOP);
			if (!(await stat(scaffoldDir)).isDirectory()) {
				throw new SampleError(`样本项目目录里的 ${APP_SCAFFOLD_TOP} 不是目录（${scaffoldDir}）→ 拒绝删除`);
			}
			const foreign = await findForeignScaffoldEntries(dir, APP_SCAFFOLD_DIRS);
			if (foreign.length > 0) {
				throw new SampleError(
					`样本项目目录里的 ${APP_SCAFFOLD_TOP} 有意外内容（${scaffoldDir}）：${foreign.join(", ")} → 拒绝删除`,
				);
			}
		}
	}
	const trust = await readJsonOrNull(paths.trustFile);
	let nextTrust = null;
	if (trust !== null) {
		if (typeof trust !== "object" || Array.isArray(trust)) {
			throw new SampleError(`trust.json 不是对象（${paths.trustFile}）：拒绝改写`);
		}
		nextTrust = { ...trust };
		for (const cwd of projectDirs) {
			if (!Object.hasOwn(nextTrust, cwd)) continue;
			if (nextTrust[cwd] !== true) {
				throw new SampleError(
					`trust.json 里样本 cwd 的值已被改成 ${JSON.stringify(nextTrust[cwd])}（${cwd}）：拒绝覆盖，人工确认后自行处理`,
				);
			}
			delete nextTrust[cwd];
		}
	}

	// 核验通过 → 执行删除（会话文件 → 会话目录 → 项目目录 → trust → 清单 → 父目录）
	for (const dir of sessionDirs) {
		const entries = await readdirOrNull(dir);
		if (entries === null) continue;
		for (const name of entries) {
			if (name === "traces") await rm(join(dir, "traces"), { recursive: true, force: true });
			else await rm(join(dir, name), { force: true });
		}
		await rmdir(dir);
	}
	for (const dir of projectDirs) {
		// 项目目录可能带应用脚手架（已逐个核验过只含那套空目录），所以是递归删
		if (await statOrNull(dir)) await rm(dir, { recursive: true, force: true });
	}
	if (nextTrust !== null) await writeFile(paths.trustFile, `${JSON.stringify(nextTrust, null, 2)}\n`, "utf8");
	await rm(manifestFile, { force: true });
	await rmdir(parent).catch(() => {}); // 父目录空了才收掉；若还有别人的东西就留着
	return { removed: true };
}

/* ---------- `--selftest`：在隔离根上验证上面那些保护（不碰正式目录） ---------- */
async function selftest() {
	/**
	 * 自检**自己的**目录也守同一条纪律：每次执行用 `mkdtemp` 新建唯一临时根，绝不碰固定路径 ——
	 * 历史版本用过 `.local/tmp/check-sidebar-sample-selftest{,-other}` 这两个固定名，若那里留着他人的
	 * 诊断资料，旧写法会在自检开头就 `rm -r` 掉。现在：① 本轮的两个根都是新建的唯一目录；
	 * ② 固定名下的既有内容只作为「不许被删」的反例被检查；③ 结束时只删本轮真正创建的目录。
	 */
	const cases = [];
	const tmpRoot = join(REPO_ROOT, ".local", "tmp");
	await mkdir(tmpRoot, { recursive: true });
	const beforeEntries = (await readdir(tmpRoot)).sort();
	const legacyFixed = join(tmpRoot, "check-sidebar-sample-selftest");
	const legacyOther = join(tmpRoot, "check-sidebar-sample-selftest-other");
	const legacyCreated = [];
	const legacyBefore = new Map();
	for (const legacy of [legacyFixed, legacyOther]) {
		if ((await statOrNull(legacy)) === null) {
			await mkdir(legacy, { recursive: true });
			// 只在自己的 fixture 里放诊断文件；路径是别人的就一个字节都不写，只做前后对照
			await writeFile(join(legacy, "reviewer-diagnostics.txt"), "do not delete me\n", "utf8");
			legacyCreated.push(legacy);
		}
		legacyBefore.set(legacy, (await readdir(legacy)).sort().join(","));
	}
	const root = await mkdtemp(join(tmpRoot, "check-sidebar-selftest-"));
	const otherRoot = await mkdtemp(join(tmpRoot, "check-sidebar-selftest-other-"));
	const record = (label, ok, detail) => {
		cases.push({ label, ok: ok === true });
		console.log(`${ok ? "PASS" : "FAIL"} · ${label} · ${detail}`);
	};
	const reset = async () => {
		// root 是本轮 mkdtemp 出来的（我们创建的），清空重建安全
		await rm(root, { recursive: true, force: true });
		await mkdir(join(root, "sessions"), { recursive: true });
		return sampleSpec({
			agentDir: root,
			sessionsRoot: join(root, "sessions"),
			trustFile: join(root, "trust.json"),
		});
	};
	const refused = async (label, run, matcher) => {
		try {
			await run();
			record(label, false, "没有按预期拒绝");
		} catch (err) {
			record(label, matcher.test(err.message), err.message);
		}
	};

	record(
		"自检的两个根是每轮新建的唯一目录（不是固定路径）",
		root !== legacyFixed && otherRoot !== legacyOther && root !== otherRoot,
		`${root} / ${otherRoot}`,
	);

	// 1) 空根：seed 成功，清单/会话/信任都落到位
	let spec = await reset();
	const seeded = await seedSample(spec);
	record(
		"空根 seed 成功并落下清单与 trust 条目",
		(await statOrNull(spec.manifestFile)) !== null &&
			(await readdirOrNull(spec.sessionDirs[0]))?.length === SAMPLE_COUNT &&
			(await readJsonOrNull(spec.paths.trustFile))?.[spec.projectDirs[0]] === true,
		`会话 ${seeded.counts.join("+")} 条 / 清单 ${MANIFEST_NAME} / trust ${SAMPLE_GROUPS.length} 个键`,
	);

	// 2) 重复 seed：拒绝（目录已在）
	await refused("已 seed 过再 seed → 拒绝（不写既有目录）", () => seedSample(spec), /清单已存在/);

	// 3) trust 冲突：干净根 + 预置同 cwd 条目 → 拒绝（不覆盖既有决定）
	const trustPath = spec.paths.trustFile;
	spec = await reset();
	await writeFile(trustPath, `${JSON.stringify({ [spec.projectDirs[0]]: true }, null, 2)}\n`, "utf8");
	await refused(
		"trust.json 已有样本 cwd 条目 → seed 拒绝（不覆盖既有决定）",
		() => seedSample(spec),
		/已有样本 cwd 的条目/,
	);
	record(
		"trust 冲突时没有创建任何样本路径",
		(await statOrNull(spec.manifestFile)) === null && (await statOrNull(spec.sessionDirs[0])) === null,
		"清单与会话目录都未创建",
	);

	// 4) 陌生文件 → clean 拒绝，且什么都不删
	spec = await reset();
	await seedSample(spec);
	const foreignFile = join(spec.sessionDirs[0], "2026-01-01T00-00-00-000Z_real-session.jsonl");
	await writeFile(foreignFile, "{}\n", "utf8");
	const beforeCount = (await readdir(spec.sessionDirs[0])).length;
	await refused("会话目录里有陌生文件 → clean 拒绝删除", () => cleanSample(spec), /陌生条目/);
	record(
		"拒绝后样本内容原样保留（什么都没删）",
		(await readdir(spec.sessionDirs[0])).length === beforeCount &&
			(await statOrNull(spec.manifestFile)) !== null &&
			(await statOrNull(foreignFile)) !== null,
		`目录内 ${beforeCount} 个条目未变`,
	);
	await rm(foreignFile, { force: true });

	// 5) 项目目录里出现陌生文件 / 陌生目录 → clean 拒绝
	await writeFile(join(spec.projectDirs[0], "unexpected.txt"), "x", "utf8");
	await refused("样本项目目录里有陌生文件 → clean 拒绝", () => cleanSample(spec), /陌生条目/);
	await rm(join(spec.projectDirs[0], "unexpected.txt"), { force: true });
	await mkdir(join(spec.projectDirs[0], ".local", "agent-work", "channel"), { recursive: true });
	await mkdir(join(spec.projectDirs[0], ".local", "agent-work", "spec"), { recursive: true });
	await mkdir(join(spec.projectDirs[0], ".local", "agent-work", "plan"), { recursive: true });
	record(
		"应用脚手架（.local/agent-work/{channel,spec,plan} 空目录）**不算**陌生内容",
		(await cleanSample(spec)).removed === true,
		"含脚手架的样本被正常清掉",
	);
	await reset();
	await seedSample(spec);

	// 5b) 脚手架里多一级 / 多一个文件 → 拒绝
	const scaffold = join(spec.projectDirs[0], APP_SCAFFOLD_TOP, "agent-work");
	await mkdir(join(scaffold, "channel"), { recursive: true });
	await mkdir(join(scaffold, "plan"), { recursive: true });
	await mkdir(join(scaffold, "spec"), { recursive: true });
	await mkdir(join(scaffold, "docs"), { recursive: true });
	await refused("脚手架里多出未登记目录 → clean 拒绝", () => cleanSample(spec), /有意外内容/);
	await rmdir(join(scaffold, "docs"));
	await writeFile(join(scaffold, "channel", "MESSAGES.md"), "x", "utf8");
	await refused("脚手架里出现文件（如频道消息）→ clean 拒绝", () => cleanSample(spec), /有意外内容/);
	await rm(join(scaffold, "channel", "MESSAGES.md"), { force: true });

	// 6) trust 值被改 → clean 拒绝
	const changed = JSON.parse(await readFile(trustPath, "utf8"));
	changed[spec.projectDirs[0]] = "someone-else";
	await writeFile(trustPath, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
	await refused("trust 值被改成非 true → clean 拒绝覆盖", () => cleanSample(spec), /值已被改成/);
	const restoredTrust = JSON.parse(await readFile(trustPath, "utf8"));
	restoredTrust[spec.projectDirs[0]] = true;
	await writeFile(trustPath, `${JSON.stringify(restoredTrust, null, 2)}\n`, "utf8");

	// 7) 清单被篡改（路径指向别处）→ clean 拒绝
	const tampered = JSON.parse(await readFile(spec.manifestFile, "utf8"));
	tampered.projectDirs = [join(root, "somewhere-else")];
	await writeFile(spec.manifestFile, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
	await refused("清单里的路径与本地推导不一致 → clean 拒绝", () => cleanSample(spec), /路径与本地推导不一致/);
	await rm(spec.manifestFile, { force: true });

	// 8) 清单缺失但残留样本路径 → 拒绝（无法证明归属）
	await refused("清单缺失但样本路径还在 → clean 拒绝", () => cleanSample(spec), /无法证明是本脚本创建的/);

	// 9) 正常清理：删干净且幂等
	await reset();
	await seedSample(spec);
	await writeFile(join(spec.sessionDirs[0], "traces", "..keep"), "", "utf8").catch(() => {}); // traces 目录可能不存在，忽略
	const cleaned = await cleanSample(spec);
	record(
		"clean 删净自己创建的一切（会话目录 / 项目目录 / trust 键 / 清单）",
		cleaned.removed === true &&
			(await statOrNull(spec.sessionDirs[0])) === null &&
			(await statOrNull(spec.projectDirs[0])) === null &&
			(await statOrNull(spec.manifestFile)) === null &&
			(await readJsonOrNull(spec.paths.trustFile))?.[spec.projectDirs[0]] === undefined,
		"目录、清单、trust 键都已消失",
	);
	const again = await cleanSample(spec);
	record(
		"再 clean 一次是幂等的 no-op（不报错也不删东西）",
		again.removed === false,
		`removed=${again.removed}`,
	);

	// 10) 独立路径：多个 agentDir 各自独立（样本不会跨根串味）
	await mkdir(join(otherRoot, "sessions"), { recursive: true });
	const otherSpec = sampleSpec({
		agentDir: otherRoot,
		sessionsRoot: join(otherRoot, "sessions"),
		trustFile: join(otherRoot, "trust.json"),
	});
	await seedSample(otherSpec);
	record(
		"隔离根之间互不影响（只删自己那份）",
		(await statOrNull(otherSpec.manifestFile)) !== null && otherSpec.projectDirs[0] !== spec.projectDirs[0],
		`另一根 ${otherRoot} 有自己的清单`,
	);
	await cleanSample(otherSpec);

	// 11) 固定名下的既有内容必须原封不动（他人的诊断资料不属于我们）—— 这正是不许用固定路径的原因
	const legacyAfter = new Map();
	for (const legacy of [legacyFixed, legacyOther]) {
		legacyAfter.set(legacy, (await readdir(legacy)).sort().join(","));
	}
	const legacyUntouched = [...legacyBefore].every(([dir, before]) => legacyAfter.get(dir) === before);
	record(
		"历史固定路径下的既有内容没被自检碰过（条目逐一对照）",
		legacyUntouched,
		`${legacyFixed}、${legacyOther} 内条目与跑前逐个一致（${[...legacyBefore.values()].join(" | ")}）`,
	);

	// 12) 本轮自己的两个根已清干净，且 .local/tmp 没有多出别的残留
	await rm(root, { recursive: true, force: true });
	await rm(otherRoot, { recursive: true, force: true });
	const leftovers = (await readdir(tmpRoot)).filter((name) => name.startsWith("check-sidebar-selftest-"));
	record(
		"只删本轮创建的目录，且清完不留残（固定名按需还原）",
		leftovers.length === 0,
		`残留 ${leftovers.length} 个自检目录`,
	);
	const afterEntries = (await readdir(tmpRoot)).sort();
	const expected = [...beforeEntries, ...legacyCreated.map((dir) => dir.split("/").pop())].sort();
	record(
		".local/tmp 里其它条目（含预置的固定名目录）数量与名字未被改变",
		JSON.stringify(afterEntries) === JSON.stringify(expected),
		`跑前 ${beforeEntries.length} 项 → 跑后 ${afterEntries.length} 项（差额 = 本轮为用例临时预置的固定名目录 ${legacyCreated.length} 个，跑完已还原）`,
	);
	// 预置的固定名目录若是本轮为用例造出来的，用例已通过 → 收掉它造的诊断文件（保留他人原有文件不变）
	for (const legacy of legacyCreated) {
		await rm(join(legacy, "reviewer-diagnostics.txt"), { force: true });
		await rm(legacy, { recursive: true, force: true });
	}

	const failed = cases.filter((c) => !c.ok);
	console.log(
		`\n${cases.length - failed.length}/${cases.length} PASS（每轮唯一隔离根，已清理；未触碰 ~/.percho/agent-dev）`,
	);
	if (failed.length > 0) {
		console.log("失败项：");
		for (const f of failed) console.log(`  - ${f.label}`);
		process.exit(EXIT_FAIL);
	}
	process.exit(EXIT_OK);
}

/* ============================ CLI 分发 ============================ */

const mode = process.argv[2];

if (mode === "--selftest") await selftest();

if (mode === "--seed" || mode === "--clean") {
	const spec = sampleSpec(DEV_PATHS);
	try {
		if (mode === "--seed") {
			const seeded = await seedSample(spec);
			console.log(`已写入样本：主组 ${seeded.counts[0]} 条 / 副组 ${seeded.counts[1]} 条`);
			for (const dir of [...spec.projectDirs, ...spec.sessionDirs]) console.log(`  ${dir}`);
			console.log(`样本清单：${spec.manifestFile}（清理只认它签名的东西）`);
			console.log("会话目录只在应用启动时读一次 → 请重启 dev，然后跑不带参数的验收。");
			console.log("用完清理：node scripts/check-sidebar-unified-scroll.mjs --clean（先停 dev）");
		} else {
			const cleaned = await cleanSample(spec);
			if (!cleaned.removed) {
				console.log("没有样本需要清理（既没有清单也没有样本路径残留）");
			} else {
				console.log("已删除本脚本创建的样本：会话目录 / 样本项目目录 / trust.json 条目 / 清单");
				console.log(
					"重启 dev 后左栏即恢复原样（样本 cwd 可能仍留在 ui-state 展开偏好里，不匹配任何组，无害）",
				);
			}
		}
		process.exit(EXIT_OK);
	} catch (err) {
		const kind = err instanceof SampleError ? "安全拒绝（什么都没改）" : "执行出错";
		console.error(`FAIL · ${kind}：${err.message}`);
		if (err instanceof SampleError) console.error("（fail-closed：不确认归属就绝不删改；确认后可人工处理）");
		process.exit(EXIT_FAIL);
	}
}
if (mode && mode !== "--check") {
	console.error(`未知参数 ${mode}：用法见本文件头部（退出码 ${EXIT_ENV}）`);
	process.exit(EXIT_ENV);
}

/* ============================ CDP 底座 ============================ */

/** 端口来自环境变量且会被拼进 URL：必须是 1–65535 的纯数字，非法值当环境错误退出 */
const RAW_PORT = process.env.CDP_PORT ?? "9224";
if (!/^\d+$/.test(RAW_PORT) || Number(RAW_PORT) < 1 || Number(RAW_PORT) > 65535) {
	console.error(`CDP_PORT 非法（${JSON.stringify(RAW_PORT)}）：应为 1–65535 的纯数字（退出码 ${EXIT_ENV}）`);
	process.exit(EXIT_ENV);
}
const PORT = Number(RAW_PORT);

async function findPage(timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) });
			const list = await res.json();
			const found = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
			if (found) return found;
		} catch {
			/* 端口未绑/非 JSON：下一轮 */
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(`等不到 page target（${PORT}）：dev 应用是否带 --remote-debugging-port=${PORT} 运行？`);
}

const page = await findPage().catch((err) => {
	console.error(`无法连接 CDP（退出码 ${EXIT_ENV}）：${err.message}`);
	process.exit(EXIT_ENV);
});
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
	}
};
await new Promise((r) => (ws.onopen = r));
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++msgId;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}
async function evalJs(expression) {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(`页面内执行失败：${JSON.stringify(result.exceptionDetails)}`);
	return result.result?.value;
}

/** 窗口被遮挡/最小化时 rAF 与 scroll 事件停摆：先把页面置为可见（PITFALLS：测量前提） */
async function focusEmulation() {
	await send("Emulation.setFocusEmulationEnabled", { enabled: true });
}
await focusEmulation();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 断言记录 ---------- */
const results = [];
function check(name, ok, detail) {
	results.push({ name, ok: ok === true });
	console.log(`${ok ? "PASS" : "FAIL"} · ${name} · ${detail}`);
}
function note(text) {
	console.log(`     ${text}`);
}
function envExit(text) {
	console.error(`\nFAIL · 环境不满足：${text}（退出码 ${EXIT_ENV}）`);
	ws.close();
	process.exit(EXIT_ENV);
}

/* ============================ 页面侧读取 ============================ */

const ROOT = `document.querySelector("[data-sidebar-scroll-root]")`;
const groupExpr = (key) => `document.querySelector('[data-sidebar-group-key="${key}"]')`;
/** 样本组（路径与断言里的 cwd 同源，都在样本段推导；断言全部按 cwd 定位，不按项目名/文案匹配） */
const samplePaths = sampleSpec(DEV_PATHS);
const SAMPLE_CWD = samplePaths.projectDirs[0];
const SAMPLE_SECOND_CWD = samplePaths.projectDirs[1];
const GROUP = groupExpr(SAMPLE_CWD);
const GROUP2 = groupExpr(SAMPLE_SECOND_CWD);
const TITLE = `${GROUP}?.querySelector("button[aria-expanded]")`;
const TITLE2 = `${GROUP2}?.querySelector("button[aria-expanded]")`;
const ROWS_IN_GROUP = (expr) => `${expr}?.querySelectorAll("[data-sidebar-session-list] [data-session-id]")`;
const SHOW_MORE = `${GROUP}?.querySelector("[data-sidebar-show-more]")`;
const SHOW_MORE2 = `${GROUP2}?.querySelector("[data-sidebar-show-more]")`;
const SEARCH_INPUT = `document.querySelector('aside.sidebar input[type="search"]')`;
/** 当前视口里某个「离上下边界都够远」的会话行（上下滚都要有空间时用） */
const VISIBLE_ROW = `[...${ROOT}.querySelectorAll("[data-sidebar-session-list] [data-session-id]")].find((row) => {
	const r = row.getBoundingClientRect();
	const a = ${ROOT}.getBoundingClientRect();
	return r.top > a.top + 40 && r.bottom < a.bottom - 40;
})`;

/** 某个分组的渲染状态（展开态 / 画了几行 / 有没有「显示更多」/ 列表是否可滚 / 行高） */
function readGroup(expr = GROUP) {
	return evalJs(`(() => {
	const g = ${expr};
	if (!g) return JSON.stringify({ error: "no-group" });
	const content = g.querySelector("[data-sidebar-group-content]");
	const list = g.querySelector("[data-sidebar-session-list]");
	const rows = list ? [...list.querySelectorAll("[data-session-id]")] : [];
	const cs = list ? getComputedStyle(list) : null;
	const title = g.querySelector("button[aria-expanded]");
	return JSON.stringify({
		state: content?.getAttribute("data-sidebar-group-content") ?? null,
		rowCount: rows.length,
		firstRowId: rows[0]?.dataset.sessionId ?? null,
		lastRowId: rows[rows.length - 1]?.dataset.sessionId ?? null,
		activeIds: rows.filter((r) => r.dataset.sessionActive === "true").map((r) => r.dataset.sessionId),
		hasButton: !!g.querySelector("[data-sidebar-show-more]"),
		hasList: !!list,
		listOverflowY: cs?.overflowY ?? null,
		listMaxHeight: cs?.maxHeight ?? null,
		listScrollH: list?.scrollHeight ?? null,
		listClientH: list?.clientHeight ?? null,
		listScrollTop: list?.scrollTop ?? null,
		titleHeight: title ? Math.round(title.getBoundingClientRect().height) : null,
		titleInsideList: !!g.querySelector("[data-sidebar-session-list] button[aria-expanded]"),
		rowHeights: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))],
	});
})()`).then(JSON.parse);
}

/** 所有会话列表容器（每个有会话的分组各一个） */
function readLists() {
	return evalJs(`(() => {
	return JSON.stringify([...document.querySelectorAll("[data-sidebar-session-list]")].map((el) => {
		const cs = getComputedStyle(el);
		return {
			rows: el.querySelectorAll("[data-session-id]").length,
			overflowY: cs.overflowY,
			maxHeight: cs.maxHeight,
			scrollH: el.scrollHeight,
			clientH: el.clientHeight,
			scrollTop: el.scrollTop,
		};
	}));
})()`).then(JSON.parse);
}

/** 主体滚动位置 + 每个列表的 scrollTop（判断某次手势影响了谁） */
function positions() {
	return evalJs(`(() => {
	const root = ${ROOT};
	return JSON.stringify({
		outer: root.scrollTop,
		outerMax: root.scrollHeight - root.clientHeight,
		lists: [...document.querySelectorAll("[data-sidebar-session-list]")].map((l) => l.scrollTop),
	});
})()`).then(JSON.parse);
}

/** 左栏滚动区内**除自身外**还能滚的元素（统一滚动的核心断言：应为空数组） */
function scanInnerScrollers() {
	return evalJs(`(() => {
	const root = ${ROOT};
	const out = [];
	for (const el of root.querySelectorAll("*")) {
		const cs = getComputedStyle(el);
		const y = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
		const x = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
		if (y || x) out.push({ tag: el.tagName, overflowY: cs.overflowY, overflowX: cs.overflowX, scrollH: el.scrollHeight, clientH: el.clientHeight });
	}
	return JSON.stringify(out);
})()`).then(JSON.parse);
}

/** 等滚动/动画落定（连续两次读数相同才算稳） */
async function settle(timeoutMs = 1200) {
	const deadline = Date.now() + timeoutMs;
	let prev = JSON.stringify(await positions());
	while (Date.now() < deadline) {
		await sleep(90);
		const cur = JSON.stringify(await positions());
		if (cur === prev) return;
		prev = cur;
	}
}

async function waitFor(expr, { timeoutMs = 6000, label = expr } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evalJs(`!!(${expr})`)) return true;
		await sleep(120);
	}
	throw new Error(`等待超时（${label}）`);
}

const waitGroupState = (state, expr = GROUP) =>
	waitFor(
		`${expr}?.querySelector("[data-sidebar-group-content]")?.getAttribute("data-sidebar-group-content") === "${state}"`,
		{ label: `分组展开态变为 ${state}` },
	);

const waitRowCount = (expected, expr = GROUP) =>
	waitFor(`${ROWS_IN_GROUP(expr)}?.length === ${expected}`, { label: `分组行数变为 ${expected}` });

/* ---------- 手势：真实鼠标 / 真实滚轮 ---------- */

/**
 * 目标中心点（默认与左栏滚动区的可见区求交；被遮挡时 `hitIsSelfOrChild` 为 false）。
 * 滚动区**之外**的固定元素（搜索框在头区、设置在尾区）要传 `clampToRoot: false` 改用窗口可见区。
 */
async function centerOf(expr, { clampToRoot = true } = {}) {
	return JSON.parse(
		await evalJs(`(() => {
	const root = ${ROOT};
	const el = ${expr};
	if (!el) return JSON.stringify(null);
	const a = ${clampToRoot ? "root.getBoundingClientRect()" : "{ top: 0, left: 0, bottom: innerHeight, right: innerWidth }"};
	const r = el.getBoundingClientRect();
	const top = Math.max(r.top, a.top);
	const bottom = Math.min(r.bottom, a.bottom);
	const left = Math.max(r.left, a.left);
	const right = Math.min(r.right, a.right);
	const cx = (left + right) / 2;
	const cy = (top + bottom) / 2;
	const hit = document.elementFromPoint(cx, cy);
	return JSON.stringify({
		cx, cy,
		visibleHeight: bottom - top,
		visibleWidth: right - left,
		hitIsSelfOrChild: !!hit && (el === hit || el.contains(hit) || hit.contains(el)),
	});
})()`),
	);
}

/** 把目标滚进左栏可视区（只是**预置**手势落点；滚动归属仍由真实 wheel 判定） */
async function reveal(expr) {
	await evalJs(
		`(() => { const el = ${expr}; if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })()`,
	);
	await settle();
}

/** 真实鼠标点击（先挪开一点再挪到目标：同一坐标的 mouseMoved 不会重算命中，见 PITFALLS） */
async function clickPoint(cx, cy) {
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx - 32, y: cy, button: "none" });
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none" });
	await send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: cx,
		y: cy,
		button: "left",
		clickCount: 1,
	});
	await send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: cx,
		y: cy,
		button: "left",
		clickCount: 1,
	});
	await sleep(120);
}

async function clickElement(expr, label = expr) {
	const c = await centerOf(expr);
	if (!c || c.visibleHeight < 6 || !c.hitIsSelfOrChild) {
		throw new Error(`目标不可点击（不可见或被遮挡）：${label} → ${JSON.stringify(c)}`);
	}
	await clickPoint(c.cx, c.cy);
}

/** 真实滚轮：指针先落到目标上（命中区决定滚动链），再派发 wheel */
async function wheelOn(expr, deltaY, times = 1) {
	const c = await centerOf(expr);
	if (!c || c.visibleHeight < 6 || !c.hitIsSelfOrChild) {
		throw new Error(`目标不可投递 wheel（不可见或被遮挡）：${expr} → ${JSON.stringify(c)}`);
	}
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.cx, y: c.cy, button: "none" });
	for (let i = 0; i < times; i++) {
		await send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: c.cx,
			y: c.cy,
			deltaX: 0,
			deltaY,
			pointerType: "mouse",
		});
		await sleep(70);
	}
	await settle();
}

/** 点分组标题：先把它滚进可视区（长列表里它可能已经滚出屏幕） */
async function clickTitle(label = "分组标题", titleExpr = TITLE) {
	await reveal(titleExpr);
	await clickElement(titleExpr, label);
}

/**
 * 在目标上投递真实 wheel，并断言「只滚主体」。
 * reveal 之后目标可能已贴在滚动边界上（例如列表末尾的按钮），所以**朝还有空间的方向**滚：
 * 否则会得到「没滚动」的假失败（边界本来就没得滚）。
 */
async function wheelRootAt(expr, label = expr) {
	await reveal(expr);
	const before = await positions();
	const deltaY = before.outerMax - before.outer >= 80 ? 120 : -120;
	await wheelOn(expr, deltaY, 2);
	const after = await positions();
	const moved = deltaY > 0 ? after.outer > before.outer : after.outer < before.outer;
	check(
		`wheel 落在${label} → 只改变左栏主体 scrollTop`,
		moved && after.lists.every((top, i) => top === before.lists[i]),
		`主体 ${before.outer}→${after.outer}（deltaY ${deltaY}）/ 各列表 scrollTop ${after.lists.join(",")}`,
	);
}

/**
 * 在主体里**动态挑一个落点**投递真实 wheel（优先非按钮区，退而求其次用会话行），
 * 并朝还有空间的方向滚。落点由 `elementFromPoint` 扫描得到，不硬编码坐标。
 */
async function wheelRootAnywhere() {
	const point = await evalJs(`(() => {
	const root = ${ROOT};
	const a = root.getBoundingClientRect();
	let fallback = null;
	for (let y = a.top + 6; y < a.bottom - 6; y += 4) {
		const x = a.left + 12;
		const hit = document.elementFromPoint(x, y);
		if (!hit || !root.contains(hit)) continue;
		if (!hit.closest("button")) return JSON.stringify({ x, y, tag: hit.tagName, text: (hit.innerText ?? "").trim().slice(0, 12) });
		fallback ??= { x, y, tag: hit.tagName, text: "" };
	}
	return JSON.stringify(fallback);
})()`).then(JSON.parse);
	if (!point) throw new Error("主体里找不到可投递 wheel 的落点");
	const before = await positions();
	const deltaY = before.outerMax - before.outer >= 80 ? 120 : -120;
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
	for (let i = 0; i < 2; i++) {
		await send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: point.x,
			y: point.y,
			deltaX: 0,
			deltaY,
			pointerType: "mouse",
		});
		await sleep(70);
	}
	await settle();
	return { before, after: await positions(), deltaY, point };
}

async function clickShowMore(times = 1, label = "「显示更多」按钮", buttonExpr = SHOW_MORE) {
	for (let i = 0; i < times; i++) {
		await reveal(buttonExpr);
		await clickElement(buttonExpr, label);
	}
}

/** 折叠再展开样本组：按 spec 语义该组回到 6 条（计数清零）。同时把展开偏好写进持久化（后续 reload 用例要用） */
async function resetSampleCount() {
	const g = await readGroup();
	if (g.state !== "expanded") {
		await clickTitle("样本组标题（展开）");
		await waitGroupState("expanded");
	}
	await clickTitle("样本组标题（折叠）");
	await waitGroupState("collapsed");
	await clickTitle("样本组标题（再展开）");
	await waitGroupState("expanded");
	await waitRowCount(INITIAL_ROWS);
	return readGroup();
}

async function setSearch(text) {
	const c = await centerOf(SEARCH_INPUT, { clampToRoot: false });
	if (!c || c.visibleHeight < 6) throw new Error("搜索框不可见，无法输入");
	await clickPoint(c.cx, c.cy);
	await evalJs(`(() => {
	const input = ${SEARCH_INPUT};
	// 受控 input：走原型 setter + input 事件，React 才收得到
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
	input.dispatchEvent(new Event("input", { bubbles: true }));
	return input.value;
})()`);
	await settle();
	await waitFor(`${SEARCH_INPUT}.value === ${JSON.stringify(text)}`, {
		label: `搜索框值变为 ${JSON.stringify(text)}`,
	});
	await sleep(220);
}

/* ============================ 1. 环境与结构 ============================ */

console.log("=== 1. 环境与结构 ===");
// 刚启动的 dev 里 renderer 可能还在挂载：先等左栏真的渲染出来，再判定环境（否则会把「还没加载完」误报成环境问题）
await waitFor(`${ROOT} !== null && document.querySelector("aside.sidebar") !== null`, {
	timeoutMs: 25000,
	label: "左栏渲染出来（若一直等不到：确认只有一份 dev 实例 —— 9224 被别的实例占用时新实例开不了 devtools）",
});
const rootInfo = await evalJs(`(() => {
	const root = ${ROOT};
	const aside = document.querySelector("aside.sidebar");
	if (!root || !aside) return JSON.stringify({ error: "no-sidebar" });
	const cs = getComputedStyle(root);
	return JSON.stringify({
		collapsed: aside.classList.contains("is-collapsed"),
		asideWidth: Math.round(aside.getBoundingClientRect().width),
		clientH: root.clientHeight,
		clientW: root.clientWidth,
		scrollH: root.scrollHeight,
		scrollW: root.scrollWidth,
		overflowY: cs.overflowY,
	});
})()`).then(JSON.parse);
if (rootInfo.error) envExit("找不到左栏或 [data-sidebar-scroll-root]（Sidebar 的改动没进包/没生效）");
if (rootInfo.collapsed || rootInfo.asideWidth === 0) {
	envExit("左栏处于收起状态：先点顶栏左侧的开合按钮把左栏展开再跑（脚本不代点，避免误判）");
}
check(
	"左栏外层滚动容器存在且纵向可滚（环境前提）",
	rootInfo.overflowY === "auto",
	`overflowY ${rootInfo.overflowY} / clientH ${rootInfo.clientH} / scrollH ${rootInfo.scrollH}`,
);
check(
	"左栏外层无横向滚动",
	rootInfo.scrollW === rootInfo.clientW,
	`scrollW ${rootInfo.scrollW} / clientW ${rootInfo.clientW}`,
);

if ((await readGroup()).error === "no-group") {
	envExit(
		`左栏里没有主样本组（cwd=${SAMPLE_CWD}）：先停 dev → node scripts/check-sidebar-unified-scroll.mjs --seed → 重启 dev → 重跑`,
	);
}
if ((await readGroup(GROUP2)).error === "no-group") {
	envExit(
		`左栏里没有副样本组（cwd=${SAMPLE_SECOND_CWD}）：搜索换词 / 临时展开这些契约需要它，缺样本一律报环境不足（` +
			"先停 dev → node scripts/check-sidebar-unified-scroll.mjs --seed → 重启 dev → 重跑）",
	);
}

// 计数清零（折叠再展开）+ 结构契约
let group = await resetSampleCount();
check(
	"折叠再展开 → 该组回到 6 条（显示更多次数清零）",
	group.rowCount === INITIAL_ROWS && group.hasButton,
	`行数 ${group.rowCount} / 有「显示更多」=${group.hasButton}`,
);

const innerScrollers = await scanInnerScrollers();
check(
	"左栏滚动区内没有任何「自己还能滚」的元素（内层滚动已彻底移除）",
	innerScrollers.length === 0,
	innerScrollers.length === 0
		? "扫描主体全部后代：0 个可滚容器"
		: `仍有可滚元素：${JSON.stringify(innerScrollers)}`,
);

const lists = await readLists();
check(
	"所有会话列表容器自身不可滚（overflow 可见、无高度上限、scrollHeight = clientHeight）",
	lists.every((l) => l.overflowY === "visible" && l.maxHeight === "none" && l.scrollH === l.clientH),
	lists
		.map(
			(l, i) =>
				`#${i}:${l.rows}行 overflowY=${l.overflowY} maxH=${l.maxHeight} scrollH=${l.scrollH}/clientH=${l.clientH}`,
		)
		.join(" / "),
);
check(
	"分组标题行渲染在列表容器之外、行高 34px",
	group.titleHeight === TITLE_HEIGHT && group.titleInsideList === false,
	`标题行 ${group.titleHeight}px / 在列表容器内=${group.titleInsideList}`,
);
check(
	"会话行仍为 31px（分批不改变行高）",
	group.rowHeights.length > 0 && group.rowHeights.every((h) => h === ROW_HEIGHT),
	`行高 ${group.rowHeights.join("/") || "无行"}`,
);

// 把主体撑到可滚（后续 wheel/固定头尾用例的前提）
await clickShowMore(3, "把样本组点满（撑高主体）");
const filled = await positions();
check("全显后主体可滚（后续滚动用例的环境前提）", filled.outerMax > 0, `可滚范围 ${filled.outerMax}px`);
if (filled.outerMax <= 0) envExit("主体撑到 45 行仍不可滚：窗口太高或其它组都折叠了，无法测滚动归属");

/* ============================ 2. 分批档位 6 → 22 → 38 → 全显 ============================ */

console.log("\n=== 2. 分批显示（6 → 22 → 38 → 全显）===");
group = await resetSampleCount();
check("0 次点击 → 6 条", group.rowCount === INITIAL_ROWS && group.hasButton, `行数 ${group.rowCount}`);
for (const [index, expected] of [INITIAL_ROWS + MORE_STEP, INITIAL_ROWS + MORE_STEP * 2].entries()) {
	await clickShowMore(1, `第 ${index + 1} 次点击「显示更多」`);
	await waitRowCount(expected);
	group = await readGroup();
	check(
		`${index + 1} 次点击 → ${expected} 条`,
		group.rowCount === expected && group.hasButton,
		`行数 ${group.rowCount}（期望 ${expected}）/ 有按钮=${group.hasButton}`,
	);
}
await clickShowMore(1, "第 3 次点击「显示更多」");
await waitRowCount(SAMPLE_COUNT);
group = await readGroup();
check(
	`第 3 次点击 → 全显 ${SAMPLE_COUNT} 条且按钮消失`,
	group.rowCount === SAMPLE_COUNT && !group.hasButton,
	`行数 ${group.rowCount}（期望 ${SAMPLE_COUNT}）/ 有按钮=${group.hasButton}`,
);
if (group.rowCount !== SAMPLE_COUNT) {
	envExit(
		`样本组只有 ${group.rowCount} 条会话（期望 ${SAMPLE_COUNT}）：样本没生成全或 dev 未重启 → --clean 后 --seed 再重启`,
	);
}

/* ============================ 2c. 键盘可达性（显示更多按钮） ============================ */

console.log("\n=== 2c. 「显示更多」的键盘可达性 ===");
{
	group = await resetSampleCount();
	const focusable = await evalJs(
		`(() => { const el = ${SHOW_MORE}; el.focus(); return document.activeElement === el; })()`,
	);
	check(
		"展开态：按钮在 Tab 序里（可以聚焦）",
		focusable === true,
		`focus() 后 activeElement 是它=${focusable}`,
	);

	// 真实 Enter 键触发（原生 button 的激活行为，不能只看 onClick 有没有绑）。
	// 注意：CDP 要 `type: "keyDown"` **且带 `text`** 才会走原生激活；`rawKeyDown` 只派事件、不产生 click（2026-09-29 实测）
	const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
	await send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r", unmodifiedText: "\r" });
	await send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
	await sleep(200);
	group = await readGroup();
	const stillFocused = await evalJs(`document.activeElement === ${SHOW_MORE}`);
	check(
		"Enter 触发一次「显示更多」→ 22 条且焦点仍在按钮上",
		group.rowCount === INITIAL_ROWS + MORE_STEP && stillFocused === true,
		`行数 ${group.rowCount} / 焦点还在=${stillFocused}`,
	);

	// 折叠态：内容 inert → 按钮不可聚焦（Tab 也进不去）
	await clickTitle("样本组标题（折叠）");
	await waitGroupState("collapsed");
	const focusableWhenCollapsed = await evalJs(
		`(() => { const el = ${SHOW_MORE}; el.focus(); return document.activeElement === el; })()`,
	);
	check(
		"折叠态：按钮不可聚焦（inert 生效，Tab 不会落到隐藏列表里）",
		focusableWhenCollapsed === false,
		`折叠态 focus() 后 activeElement 是它=${focusableWhenCollapsed}`,
	);
	await clickTitle("样本组标题（再展开）");
	await waitGroupState("expanded");
}

/* ============================ 2b. 侧栏整体收起再展开 ≠ 项目折叠 ============================ */

console.log("\n=== 2b. 侧栏整体收起再展开不重置分批计数 ===");
{
	const toggle = `document.querySelector("[data-sidebar-toggle]")`;
	// 建立自己的基线（上一节结束时行数不由它决定）：点满到全显，再验证侧栏开合不动它
	await clickShowMore(3, "把样本组点满（侧栏开合用例的基线）");
	await waitRowCount(SAMPLE_COUNT);
	const before = await readGroup();
	const c = await centerOf(toggle, { clampToRoot: false });
	if (!c || c.visibleHeight < 6) envExit("找不到左栏开合按钮（[data-sidebar-toggle]）");
	await clickPoint(c.cx, c.cy);
	await waitFor(`document.querySelector("aside.sidebar")?.classList.contains("is-collapsed") === true`, {
		label: "左栏收起",
	});
	await sleep(320); // 等宽度过渡走完
	const c2 = await centerOf(toggle, { clampToRoot: false });
	if (!c2 || c2.visibleHeight < 6) throw new Error("左栏收起后开合按钮不可点");
	await clickPoint(c2.cx, c2.cy);
	await waitFor(`document.querySelector("aside.sidebar")?.classList.contains("is-collapsed") === false`, {
		label: "左栏重新展开",
	});
	await sleep(320);
	const after = await readGroup();
	check(
		"收起再展开左栏 → 该组仍是 45 条（侧栏开合不算项目折叠，计数不重置）",
		before.rowCount === SAMPLE_COUNT && after.rowCount === before.rowCount && after.state === before.state,
		`行数 ${before.rowCount}→${after.rowCount} / state ${before.state}→${after.state}`,
	);
}

/* ============================ 3. 真实 wheel 的滚动归属 ============================ */

console.log("\n=== 3. 真实 wheel 只滚同一个主体 ===");
// 先把计数降到 2 次（38 条）→ 按钮还在，能拿它当落点
await resetSampleCount();
await clickShowMore(2, "降到 2 次点击（38 条，按钮仍在）");
await waitRowCount(INITIAL_ROWS + MORE_STEP * 2);

{
	await wheelRootAt(`${ROWS_IN_GROUP(GROUP)}[3]`, "会话行上");
	await wheelRootAt(TITLE, "项目标题行上");
	await wheelRootAt(SHOW_MORE, "「显示更多」按钮上");

	// 非交互区（分组小标文字 / 组间空隙）：落点由扫描得出，不硬编码坐标
	await evalJs(`${ROOT}.scrollTop = 0`);
	await settle();
	const blank = await wheelRootAnywhere();
	check(
		`wheel 落在左栏非交互区（<${blank.point.tag}> ${JSON.stringify(blank.point.text)}）→ 同样只滚主体`,
		blank.deltaY > 0 ? blank.after.outer > blank.before.outer : blank.after.outer < blank.before.outer,
		`落点 (${Math.round(blank.point.x)},${Math.round(blank.point.y)}) / 主体 ${blank.before.outer}→${blank.after.outer}`,
	);
	check(
		"非交互区落点的每次 wheel 都不改变任何列表自身的 scrollTop",
		blank.after.lists.every((top, i) => top === blank.before.lists[i]),
		`各列表 ${blank.before.lists.join(",")}→${blank.after.lists.join(",")}`,
	);

	// 反方向也走同一个容器（不存在「指针在会话行上就滚不动」）：
	// 先滚到中部，保证上下都有空间，再挑一个离边界够远的会话行当落点
	await evalJs(`${ROOT}.scrollTop = Math.round((${ROOT}.scrollHeight - ${ROOT}.clientHeight) / 2)`);
	await settle();
	const beforeUp = await positions();
	await wheelOn(VISIBLE_ROW, -120, 2);
	const afterUp = await positions();
	check(
		"向上滚 → 主体回滚（正反方向归属一致）",
		afterUp.outer < beforeUp.outer && afterUp.lists.every((top) => top === 0),
		`主体 ${beforeUp.outer}→${afterUp.outer}`,
	);
}

/* ============================ 4. 头尾固定 ============================ */

console.log("\n=== 4. 头尾固定在滚动区之外 ===");
{
	const readHeaderFooter = () =>
		evalJs(`(() => {
	const inner = document.querySelector("aside.sidebar .sidebar-inner");
	const root = ${ROOT};
	const header = inner.firstElementChild;
	const footer = inner.lastElementChild;
	const h = header.getBoundingClientRect();
	const f = footer.getBoundingClientRect();
	return JSON.stringify({
		headerInsideRoot: root.contains(header),
		footerInsideRoot: root.contains(footer),
		headerTop: h.top,
		footerTop: f.top,
	});
})()`).then(JSON.parse);
	await evalJs(`${ROOT}.scrollTop = 0`);
	await settle();
	const before = await readHeaderFooter();
	const scrolled = await wheelRootAnywhere();
	const after = await readHeaderFooter();
	check(
		"新会话/搜索（头）与设置（尾）都在滚动区之外",
		before.headerInsideRoot === false && before.footerInsideRoot === false,
		`头在滚动区内=${before.headerInsideRoot} / 尾在滚动区内=${before.footerInsideRoot}`,
	);
	check(
		"滚主体时头尾不移动（固定）",
		after.headerTop === before.headerTop &&
			after.footerTop === before.footerTop &&
			scrolled.after.outer !== scrolled.before.outer,
		`头 ${before.headerTop}→${after.headerTop} / 尾 ${before.footerTop}→${after.footerTop} / 主体 ${scrolled.before.outer}→${scrolled.after.outer}`,
	);
}

/* ============================ 5. 搜索：临时展开、计数隔离与换词重置 ============================ */

console.log("\n=== 5. 搜索语义 ===");
{
	// 基线：主组正常模式 3 次点击 = 全显 45 条且展开；副组保持折叠（搜索临时展开才有可观测差异）
	group = await resetSampleCount();
	await clickShowMore(3, "把主样本组点满，作为正常模式的基线");
	await waitRowCount(SAMPLE_COUNT);
	const base = await readGroup();
	check(
		"基线：主组正常模式 45 条（3 次点击）",
		base.rowCount === SAMPLE_COUNT && !base.hasButton,
		`行数 ${base.rowCount}`,
	);
	if ((await readGroup(GROUP2)).state === "expanded") {
		await clickTitle("副样本组标题（先折叠）", TITLE2);
		await waitGroupState("collapsed", GROUP2);
	}
	const secondBefore = await readGroup(GROUP2);
	check("基线：副样本组折叠", secondBefore.state === "collapsed", `state=${secondBefore.state}`);

	// --- A：搜索副组名前缀 → 副组临时展开、主组（无命中）被隐藏、搜索态计数从 6 开始 ---
	await setSearch(SAMPLE_SECOND_NAME_PREFIX);
	const secondSearched = await readGroup(GROUP2);
	check(
		"搜索命中折叠中的组 → 临时展开（不看持久化折叠偏好）",
		secondBefore.state === "collapsed" && secondSearched.state === "expanded",
		`搜索前 ${secondBefore.state} → 搜索时 ${secondSearched.state}`,
	);
	check(
		"搜索态计数独立：从 6 条开始（不是该组正常模式的次数）",
		secondSearched.rowCount === INITIAL_ROWS && secondSearched.hasButton,
		`行数 ${secondSearched.rowCount}（副组共 ${SAMPLE_SECOND_COUNT} 条）/ 有按钮=${secondSearched.hasButton}`,
	);
	check(
		"无命中的组被隐藏（搜索确实生效，不是输入没进去）",
		(await readGroup()).error === "no-group",
		`主组（无命中 ${JSON.stringify(SAMPLE_NAME_PREFIX)}）在搜索中不渲染=${(await readGroup()).error === "no-group"}`,
	);

	// --- 搜索态「显示更多」→ 副组全显；换词 A→B 应把计数清零（回 6 条）---
	await clickShowMore(1, "搜索态的「显示更多」（副组）", SHOW_MORE2);
	await waitRowCount(SAMPLE_SECOND_COUNT, GROUP2);
	const afterMore = await readGroup(GROUP2);
	check(
		"搜索态点一次「显示更多」→ 副组全显",
		afterMore.rowCount === SAMPLE_SECOND_COUNT && !afterMore.hasButton,
		`行数 ${afterMore.rowCount}（期望 ${SAMPLE_SECOND_COUNT}）`,
	);
	await setSearch(`${SAMPLE_SECOND_NAME_PREFIX} 0`); // 换词（同样命中全部）
	await waitRowCount(INITIAL_ROWS, GROUP2);
	check(
		"搜索词 A→B：搜索态计数清零（回到 6 条）",
		(await readGroup(GROUP2)).rowCount === INITIAL_ROWS,
		`行数 ${(await readGroup(GROUP2)).rowCount}（期望 ${INITIAL_ROWS}）`,
	);

	// --- 搜索期间临时折叠 → 重开回 6 条；换词应清掉临时折叠 ---
	await clickTitle("搜索态标题（临时折叠）", TITLE2);
	await waitGroupState("collapsed", GROUP2);
	await clickTitle("搜索态标题（重新展开）", TITLE2);
	await waitGroupState("expanded", GROUP2);
	await waitRowCount(INITIAL_ROWS, GROUP2);
	check(
		"搜索期间折叠再展开 → 回到 6 条（搜索态自己的计数被清）",
		(await readGroup(GROUP2)).rowCount === INITIAL_ROWS && (await readGroup(GROUP2)).hasButton,
		`行数 ${(await readGroup(GROUP2)).rowCount} / 有按钮=${(await readGroup(GROUP2)).hasButton}`,
	);
	await clickTitle("搜索态标题（再次临时折叠）", TITLE2);
	await waitGroupState("collapsed", GROUP2);
	await setSearch(SAMPLE_SECOND_NAME_PREFIX); // 换回 A（也是换词）
	await waitGroupState("expanded", GROUP2);
	await waitRowCount(INITIAL_ROWS, GROUP2);
	check(
		"搜索词换回 A：临时折叠被清掉（该组重新展开）",
		(await readGroup(GROUP2)).state === "expanded" && (await readGroup(GROUP2)).rowCount === INITIAL_ROWS,
		`state=${(await readGroup(GROUP2)).state} / 行数 ${(await readGroup(GROUP2)).rowCount}`,
	);

	// --- 清空搜索：副组回到搜索前的折叠态（临时展开没写持久化）、主组正常计数仍 45 ---
	// （此刻主组因无命中而不渲染，所以这里不能等它的行数）
	await setSearch("");
	await waitGroupState("collapsed", GROUP2);
	const secondCleared = await readGroup(GROUP2);
	const mainCleared = await readGroup();
	check(
		"清空搜索 → 副组回到搜索前的折叠态（临时展开未写回持久化偏好）",
		secondCleared.state === "collapsed",
		`state=${secondCleared.state}（搜索前 collapsed）`,
	);
	check(
		"清空搜索 → 主组正常模式的计数未被搜索点击污染（仍 45 条）",
		mainCleared.rowCount === SAMPLE_COUNT && !mainCleared.hasButton && mainCleared.state === "expanded",
		`行数 ${mainCleared.rowCount}（期望 ${SAMPLE_COUNT}）/ state=${mainCleared.state}`,
	);
	const searchValue = await evalJs(`${SEARCH_INPUT}.value`);
	check("搜索框已清空", searchValue === "", `input.value=${JSON.stringify(searchValue)}`);
}

/* ============================ 6. reload（重启等价）：计数回 6、展开偏好保留 ============================ */

console.log("\n=== 6. reload 后：显示更多次数清零、展开偏好保留 ===");
{
	group = await readGroup();
	check(
		"reload 前的基线：该组展开且 45 条（3 次点击）",
		group.state === "expanded" && group.rowCount === SAMPLE_COUNT,
		`state=${group.state} / 行数 ${group.rowCount}`,
	);
	await sleep(700); // 等 ui-state 落盘
	await send("Page.reload", {});
	await sleep(500);
	await focusEmulation();
	await waitFor(`${GROUP} !== null`, { timeoutMs: 25000, label: "reload 后样本组重新渲染出来" });
	await waitGroupState("expanded");
	const after = await readGroup();
	check(
		"reload（等价重启）后该组回到 6 条 —— 分批计数只在内存里",
		after.rowCount === INITIAL_ROWS && after.hasButton,
		`行数 ${after.rowCount} / 有按钮=${after.hasButton}`,
	);
	check("reload 后展开偏好仍保留（组还是展开的）", after.state === "expanded", `state=${after.state}`);
	check(
		"reload 后副组仍折叠（搜索期间的临时展开没有被持久化）",
		(await readGroup(GROUP2)).state === "collapsed",
		`副组 state=${(await readGroup(GROUP2)).state}`,
	);
}

/* ============================ 7. active 越界不破例 ============================ */

console.log("\n=== 7. 当前活跃会话超出已显示范围时不破例 ===");
{
	await clickShowMore(3, "全显样本组（准备点最后一条）");
	await waitRowCount(SAMPLE_COUNT);
	group = await readGroup();
	const lastId = group.lastRowId;
	const lastIndex = group.rowCount - 1;
	const lastRow = `${ROWS_IN_GROUP(GROUP)}[${lastIndex}]`;
	await reveal(lastRow);
	await clickElement(lastRow, "最后一条样本会话（最旧）");
	await waitFor(
		`${GROUP}?.querySelector('[data-session-id="${lastId}"][data-session-active="true"]') !== null`,
		{
			timeoutMs: 15000,
			label: `最后一条样本会话变为 active（${lastId}）`,
		},
	);

	// 折叠 → 再展开：计数清零回到 6 条，此时 active 排在 6 条之外
	await clickTitle("样本组标题（折叠）");
	await waitGroupState("collapsed");
	await clickTitle("样本组标题（再展开）");
	await waitGroupState("expanded");
	await waitRowCount(INITIAL_ROWS);
	group = await readGroup();
	check(
		"active 会话排在 6 条之外时不额外露出（行数仍是 6、active 行不在 DOM 里）",
		group.rowCount === INITIAL_ROWS && !group.activeIds.includes(lastId),
		`行数 ${group.rowCount} / 已显示的 active 行=${JSON.stringify(group.activeIds)}（最后一条 = ${lastId}）`,
	);
	note("排序按最后活动时间；点开历史会话不产生新活动，所以它仍在最末位");
}

/* ============================ 8. 右键菜单随主体滚动关闭 ============================ */

console.log("\n=== 8. 右键菜单随滚动关闭 ===");
{
	// 右键菜单的「滚动关闭」要主体真的能滚：先把样本组点满（上一节结束时只有 6 条，可能整页放得下）
	await clickShowMore(3, "把样本组点满（让主体可滚）");
	await waitRowCount(SAMPLE_COUNT);
	const rowExpr = `${ROWS_IN_GROUP(GROUP)}[1]`;
	await reveal(rowExpr);
	const c = await centerOf(rowExpr);
	if (!c || c.visibleHeight < 6) envExit("会话行不可见，无法开右键菜单");
	await send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: c.cx,
		y: c.cy,
		button: "right",
		clickCount: 1,
	});
	await send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: c.cx,
		y: c.cy,
		button: "right",
		clickCount: 1,
	});
	await waitFor(`document.querySelector('[role="menu"]') !== null`, { label: "会话行右键菜单出现" });

	// 菜单挂在指针处会盖住一片：落点要避开它的矩形（被盖住的落点 wheel 会被菜单吃掉）
	const before = await positions();
	const deltaY = before.outerMax - before.outer >= 80 ? 120 : -120;
	const point = await evalJs(`(() => {
	const root = ${ROOT};
	const menu = document.querySelector('[role="menu"]')?.getBoundingClientRect();
	const a = root.getBoundingClientRect();
	for (let y = a.top + 8; y < a.bottom - 8; y += 6) {
		const x = a.left + 12;
		const blocked = menu && x >= menu.left - 4 && x <= menu.right + 4 && y >= menu.top - 4 && y <= menu.bottom + 4;
		const hit = document.elementFromPoint(x, y);
		if (!blocked && hit && root.contains(hit) && !document.querySelector('[role="menu"]')?.contains(hit)) {
			return JSON.stringify({ x, y });
		}
	}
	return JSON.stringify(null);
})()`).then(JSON.parse);
	if (!point) envExit("左栏内找不到不被右键菜单遮挡的滚动落点");
	if (before.outer === before.outerMax && before.outer === 0)
		envExit("主体不可滚，无法验证右键菜单随滚动关闭");

	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
	for (let i = 0; i < 2; i++) {
		await send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: point.x,
			y: point.y,
			deltaX: 0,
			deltaY,
			pointerType: "mouse",
		});
		await sleep(70);
	}
	await settle();
	const after = await positions();
	const menuGone = (await evalJs(`document.querySelector('[role="menu"]') === null`)) === true;
	const moved = deltaY > 0 ? after.outer > before.outer : after.outer < before.outer;
	check(
		"右键菜单打开后滚动主体 → 菜单关闭且主体真的滚了",
		menuGone && moved,
		`菜单还在=${!menuGone} / 主体 ${before.outer}→${after.outer}（deltaY ${deltaY}）`,
	);
}

/* ============================ 9. 收尾 ============================ */

await setSearch("");
await evalJs(`${ROOT}.scrollTop = 0`);
await settle();
check("收尾：主体 scrollTop 复位为 0", (await positions()).outer === 0, `outer=${(await positions()).outer}`);

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
	console.log("失败项：");
	for (const f of failed) console.log(`  - ${f.name}`);
	process.exit(EXIT_FAIL);
}
console.log("统一滚动 + 分批显示验收通过。样本清理：先停 dev，再跑 --clean");
process.exit(EXIT_OK);
