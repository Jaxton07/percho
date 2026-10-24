# UI 插件的设置页、配置存储与隔离

本页描述 `perchoUi: 2` 起生效的三块能力：宿主按字段表生成的设置页、插件自有配置的存储与迁移、shadow 内的样式来源。插件面向的字段契约见 `packages/desktop/resources/ui-plugins/SPEC.md`，本页不重复字段定义，只讲本地实例、生效条件、边界与验证。

## 本地实例

```bash
cd packages/desktop
npm run dev -- -- --remote-debugging-port=9555 --user-data-dir=/tmp/percho-pv
```

用户目录落在 `/tmp/percho-pv-dev`（dev 自动补 `-dev` 后缀），与 `~/.percho` 隔离。

- 插件放在 `<userData>/ui-plugins/<name>/`。主进程 `fs.watch` 递归监听，改 `plugin.json` 或源码即重扫重建。
- 配置与启用状态在 `<userData>/ui-plugins.json`。
- 启用入口是设置 → 外观 → UI 插件。总开关关闭时插件不加载，设置分类也不会出现。
- 构建失败、导出缺失、缺依赖都显示在该面板的行内错误里。

## 声明式设置页

`plugin.json` 只加一段 `settingsSchema`，页面由宿主按字段表渲染，插件侧没有设置 UI 代码。

```json
{
	"perchoUi": 2,
	"settingsSchema": {
		"version": 1,
		"fields": {
			"prefix": { "type": "string", "label": { "zh": "前缀", "en": "Prefix" }, "default": "bw" },
			"showBadge": { "type": "boolean", "label": "显示角标", "default": true },
			"interval": { "type": "number", "label": "刷新间隔", "default": 15, "min": 1, "max": 600 }
		}
	}
}
```

设置导航里出现 `displayName` 需要三个条件同时成立：插件目录被 `scanAll` 扫到、配置里该插件 `enabled` 且 `trusted`（在面板启用即视为信任）、声明了 `settingsSchema` 且没有等价的 `settings.panel` 贡献（有贡献时以贡献为准，不重复生成）。未启用的插件不生成任何设置分类。

值落在 `plugins["<name>"].settings`。已存值与字段 `type` 不符时按默认值渲染，不做隐式转换。

## 读取配置

设置页只负责写，插件侧用 `usePluginSettings` 读同一份值，改完即时生效。

```tsx
const { values, update } = usePluginSettings("my-plugin", { showBadge: true });
values.showBadge; // 缺键时才用 defaults；defaults 不写盘
update({ showBadge: false }); // 乐观更新，失败回滚
```

`defaults` 必须是稳定引用（组件外常量或 `useMemo`），内联字面量会让合并结果每次换新对象。配置写入只发窄事件 `settings`，宿主只重读该插件的配置，不重载插件代码。

## 声明式迁移

改字段形状时把 `version` 加一，并给出到该版本的一步迁移，宿主读配置时逐级升级并回写，插件不写迁移代码。

```json
"settingsSchema": {
	"version": 2,
	"migrations": { "2": { "rename": { "oldName": "prefix" }, "drop": ["legacyFlag"], "set": { "interval": 15 } } }
}
```

- key 是目标版本（`"2"` 表示 v1 → v2），从存储版本逐级往上跑，缺哪一步就停在哪一步。
- 动作只有 `rename`、`set`（只补缺键）、`drop`（最后执行）三类，均为纯数据变换，不执行插件代码。
- 进度记在 `settingsVersion`；缺该字段时按 v1 处理，版本化之前的老配置同样会被迁到。
- 读配置时触发：打开该插件的设置分类，或执行 `await window.pi.uiPluginsGetSettings({ name: "<name>" })`。

需要跳过真实升级时，把配置改成旧键并删掉 `settingsVersion`，再重开实例：

```bash
python3 -c 'import json,pathlib;p=pathlib.Path("/tmp/percho-pv-dev/ui-plugins.json");d=json.loads(p.read_text());e=d["plugins"]["<name>"];e["settings"]={"oldName":"bw-old"};e.pop("settingsVersion",None);p.write_text(json.dumps(d,ensure_ascii=False,indent=2))'
```

## 自带样式与 shadow 隔离

```json
"styles": ["src/style.css"],
"contributions": [
	{ "id": "badge", "region": "chat.corner.top-right", "export": "Badge", "isolation": "shadow" }
]
```

- `styles` 合成一个 `dist/index.css`，**只注入 `isolation: "shadow"` 的贡献**。light 隔离下不注入，加载时打一条「声明了 styles，但没有 isolation="shadow" 的贡献」告警，不要据此判断构建失败。
- host 上设 `contain: layout paint style`：插件撑不破设置弹窗，但**超出宿主框的内容会被裁掉**，`position: fixed` 同样无法脱离宿主框。
- 字号用 `--p-fs-11/12/13`，已乘 `--fs-ui-scale`，跟随用户的字号设置，不写死 px。
- 语义类见 `renderer/src/plugins/plugin-theme.ts`（`.psection`、`.prow`、`.pfield`、`.pbtn`、`.pform`、`.pfull`）。改类名或令牌名属破坏性变更，需同时把 `PLUGIN_THEME_VERSION` 加一。

实际隔离方式记录在 `data-percho-surface` 上，降级时取值为 `light`：

```js
const host = document.querySelector('[data-percho-surface="shadow"]');
host.shadowRoot.adoptedStyleSheets.length; // 2 = 主题表 + 插件 css
```

## 版式

`layout` 缺省为 `form`，内容区自带 `px-4 py-3` 和外层滚动。`layout: "full"` 把滚动权交给插件，内容区不再套内边距，用于编辑器或列表类面板。

## 边界

配置落盘前做有界校验，越界整批拒绝并抛错，不静默截断。

| 项 | 限制 |
| --- | --- |
| 配置键名 | `/^[A-Za-z0-9_.-]{1,64}$/` |
| 配置值 | 仅 string、number、boolean、null；字符串长度 ≤ 4096 |
| 配置规模 | ≤ 64 键；序列化后 ≤ 32KB |
| `settingsSchema` | ≤ 32 字段；`migrations` ≤ 16 步，每步每类动作 ≤ 32 项 |

## shadow 内不可用

- 宿主 Tailwind 工具类（`text-ui-13`、`bg-surface` 等）不存在。
- 宿主组件（`components.Switch`、`Button` 等）靠宿主类渲染，进 shadow 后没有样式，只在 `isolation: "light"` 下可用。
- shadow 内外互相查不到节点：`document.querySelector` 看不到 shadow 内，shadow 内也看不到宿主节点。

## 代码入口

| 要改什么 | 从哪里开始 |
| --- | --- |
| manifest 校验（`styles`、`settingsSchema`、`migrations`、`layout`、`isolation`） | `main/ui-plugins/manifest.ts` |
| 配置读取、有界校验、迁移算法 | `main/ui-plugins/settings.ts`、`config.ts` |
| 插件 CSS 构建（virtual stdin 串 `@import`） | `main/ui-plugins/build.ts` |
| 配置读写 IPC、迁移回写 | `main/ipc/ui-plugins.ts` |
| 主题表（令牌、语义类、暗色）与自定义样式装载 | `renderer/plugins/plugin-theme.ts`、`plugin-assets.ts` |
| shadow 挂载与降级；声明式设置页渲染 | `renderer/plugins/ShadowSurface.tsx`、`settings-schema-form.tsx`、`settings-schema.ts` |
| 配置缓存与 `usePluginSettings`；`layout` 让位 | `renderer/stores/plugin-settings.ts`、`plugins/use-plugin-settings.ts`、`components/settings/SettingsDialog.tsx` |

## 已知限制

- 迁移动作固定三类，不提供自定义迁移函数，升级路径必须静态可查。
- 迁移不清理未声明的旧键，避免误删插件自己存的其他键。
- 改配置不重载插件代码，新代码生效需在 UI 插件面板重建。
- 每次字段变更写一次 `ui-plugins.json`，无防抖；文件很小，单次写入可忽略。
- `~/.percho/ui-plugins` 是宿主维护的 symlink，改成实体目录后宿主会跳过它。

## 验证

```bash
npm run lint && npm run typecheck && npm run test
```

相关用例：`main/ui-plugins/settings.test.ts`（上限与迁移规则）、`main/ui-plugins/manifest.test.ts`（manifest 校验）、`renderer/src/plugins/settings-schema.test.ts`（取值回落）。`packages/backend/test/sdk-run-lifecycle.test.ts` 在缺 `marked-cjk-friendly.min.js` 的已安装环境会失败，与本模块无关。

## 示例插件

[`docs/examples/plugin-settings/`](examples/plugin-settings/) 是可运行的完整例子，覆盖设置页、shadow 样式与实时读配置。它不在 `resources/ui-plugins/examples/` 下：那个目录会被 seeder 拷进每个用户的 `_examples/`，等于预装。原版 Percho 的默认状态不改动，需要时复制进 dev 实例再启用。
