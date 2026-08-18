---
name: percho-ui-plugin
description: Percho 桌面端 UI 插件（槽位组件替换）。用户说「改 XX 组件样式 / 把 XX 换成 YY 风格 / 给 XX 加个功能 / DIY 界面 / 定制界面 / 界面能改什么 / 换风格」且对象是聊天界面里的工具调用卡、子代理卡、任务列表面板时使用。按 SPEC 在 ~/.percho/ui-plugins/ 下 scaffold 插件，保存即热重载，最后引导用户在设置面板启用。
---

# Percho UI 插件

用户想让 Percho 的聊天界面组件（工具调用卡 / 子代理卡 / 任务列表面板）**换样式或换行为**时，用 UI 插件机制实现：写一个 TSX 插件覆盖对应槽位，宿主自动构建 + 热重载。

## 流程

1. **读规范**：`~/.percho/ui-plugins/SPEC.md`（槽位表、props 契约、硬约束、样式纪律）+ `~/.percho/ui-plugins/percho-ui.d.ts`（类型）。两个文件宿主已随应用分发。
2. **scaffold**：在 `~/.percho/ui-plugins/<name>/`（注意：此路径是宿主建好的 symlink，指向 userData 真实目录）创建：

   ```
   <name>/plugin.json      # name 必须与目录名一致；perchoUi:1；slots 声明覆盖的槽位
   <name>/src/index.tsx    # 入口（memo 包裹 + 语义 token + 只 import react / @percho/plugin-api / 相对路径图片资产）
   ```

   直接抄 `~/.percho/ui-plugins/_examples/terminal-tool-card/` 改最快。
3. **保存即构建**：宿主 fs.watch 300ms 防抖自动重建。语法/导入错误 → 旧版继续生效、设置面板显示「构建失败」——修完再保存即可。
4. **引导用户启用**（**必须**，agent 无权代劳——信任门）：告诉用户去 **设置 → UI 插件**：开总开关 → 点「启用」→ 二次确认。之后界面立即替换。
5. **迭代**：用户确认生效后，继续改 `src/index.tsx` 保存即热替换，不用重启、不用重新启用。

## 硬约束（违反必返工）

- 只准 import `react` / `@percho/plugin-api`，其他 npm 包一律禁止（构建直接失败）；
- 图片资产例外：相对路径导入 `.png/.webp/.gif/.jpg` → 构建器内联为 data URL（SPEC §3，桌宠立绘用；先缩到显示尺寸 2x 再导入）；
- 禁 Node API、禁 fetch、禁 localStorage、禁 `window.pi`（插件只能碰 `window.PerchoUI`）；
- 样式一律语义 token（`bg-surface`/`text-ink`/`border-border`/…），**禁写死 zinc/white**，深浅主题都要验证；
- 导出组件必须 `React.memo` 包裹；
- `plugin.json` 的 `name` 必须匹配 `/^[a-z0-9][a-z0-9-]*$/` 且与目录名一致，`slots` 的 key 必须是 SPEC 表里的槽位名。
