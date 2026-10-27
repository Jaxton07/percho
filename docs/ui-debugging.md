# UI 调试与验收

适用于 Electron 实机交互、截图和渲染问题。用 **CDP 页面截图，不用系统截图**：不依赖录屏权限或窗口无遮挡，并可确定性复现动画。

## 启动与确认实例

在仓库根目录准备 `.local/tmp/<任务>/` 存日志、截图和夹具。启动：

```bash
cd packages/desktop
npx electron-vite dev -- --remote-debugging-port=9224
```

不要改成 `npm run dev -- --remote-debugging-port=9224`：npm 会吞参数。需要 main inspector 的脚本还要按脚本头加入 `--inspect=9229`。

1. 启动前检查目标端口，记录本次进程 PID；启动后确认日志出现 DevTools listening、没有端口绑定失败。
2. CDP 连接后核对 `location.href` 与实际页面，`chrome-error://` 表示连到了错误页，不是业务组件不存在。
3. 测试结束关闭本次 Electron 及其 dev server，确认端口释放。只杀 electron-vite 包装进程可能留下 Electron；不要用宽泛的 `pkill -f Electron`，以免结束正式版。

开始输入前等待 `html[data-app-ready="true"]` 且 `#splash` 已移除。开屏期间 React 节点已经存在，但 `#root` 的 `content-visibility: hidden` 会让焦点和输入无法到达；不能以查到按钮或输入节点作为可交互的证据。

验收首次数据准备时，等待 `html[data-startup-view="setup"] .startup-layout`，这时工作台尚未就绪，不能等 `data-app-ready`。已迁移用户应始终没有 `.startup-layout`；验证无闪屏须从首帧观察，而非只看启动完成后的截图。两种路径都应只有一个窗口和一次业务页面导航。

main 修改没有生效时先核对 `packages/desktop/out/main/index.js` 是否重建；改 store 后 HMR 可能留下旧订阅或实例。**最终验收用干净重启，不把 HMR 异常当产品结论。**

## 隔离与 seed

- dev agent dir：`~/.percho/agent-dev/`。
- 当前开发 userData：`~/Library/Application Support/@percho/desktop-dev/`；不要使用改名前的 `percho-dev/`。
- 路径逻辑以 `main/dev-agent-dir.ts` 为准；自定义隔离使用绝对 `PERCHO_AGENT_DIR` 和独立 `--user-data-dir`，脚本跟随同一根。首次未标记目标需明确采用；不能绕过启动页直接 seed 正式数据。详见[迁移与恢复](local-agent-storage.md)。
- `ui-state.json` 必须在实例停止后 seed，否则运行中的 persist 会覆盖。会话目录夹具通常也需重启才能读入。
- 工作区快照使用 `sessionWorkspace`，不再有 `tabs.json`；冷启动可恢复有效 activeFile，不要假设总是新会话页。
- 尽量通过真实 UI 进入目标状态；不得直接修改正式配置、会话或凭证来凑验收场景。

## 现成工具

在仓库根目录执行：

```bash
node scripts/cdp-eval.mjs "location.href"
node scripts/shoot-sidebar.mjs both .local/tmp/ui-review
```

`cdp-shot.mjs` 用于页面截图；`shoot-sidebar.mjs` 是动画逐帧模板。专项脚本查 `scripts/check-*`、`verify-*`、`shoot-*` 的文件头，那里定义参数、退出码、夹具清理与安全前提。

窗口被遮挡/最小化时 `document.hidden` 可能为 true，rAF 与滚动事件会停摆。脚本连接后先调用 `Emulation.setFocusEmulationEnabled({ enabled: true })`，不要让等待 rAF 的脚本无限挂住。

## 确定性截图

1. 触发目标状态，等 React 提交及布局稳定。合成 MouseEvent 可以触发 React 委托事件，但不能建立浏览器真实 `:hover`。
2. 动画优先按 CSS 两端取值、时长和缓动函数计算目标时刻，关闭过渡后写成 inline style 再截图。参考 `shoot-sidebar.mjs`；不要把全量 pause WAAPI 当通用办法，后台合成器可能不产新帧，截到旧图或空白。
3. 用 `Page.captureScreenshot`，clip 单位为 CSS px；输出像素 = clip × scale × DPR，通常 `scale: 1`，不要重复乘 Retina 倍率。
4. 复位只删除本脚本写入的 inline 属性，不用 `cssText = ""` 清掉 React 管理的变量；finally 恢复窗口、夹具、样式并关闭调试连接。

小区域 clip 偶发空白可用全窗截图核对；不要对已暂停动画的陈旧帧无休止重试。headless 截图可能不绘制滚动条，不能凭像素断言“没有滚动条”。

## 交互不能只靠截图证明

- **hover 与点击**：使用 CDP 真实鼠标。截图可能清 hover；下一次移动先离开一点再回来，同坐标 mouseMoved 不保证重算。拖动途中不要截图打断指针捕获，松手坐标保持在视口内。
- **点击命中**：用 `elementFromPoint`、实际点击结果与可交互元素边界验证；rect 看似正确不代表没有透明元素覆盖。
- **滚动归属**：发真实 wheel，核对哪个容器 scrollTop 变化；直接赋值 scrollTop 不能证明真实滚轮路径。嵌套滚动与 overscroll-behavior 可能吞掉事件。
- **窗口行为**：CDP 鼠标不驱动 `-webkit-app-region: drag` 的原生拖窗；人工确认。当前 Electron 不支持 `Browser.setWindowBounds` 时可用页面 `window.resizeTo` 调整尺寸。
- **状态夹具**：注入 store 使用完整对象形状，并在 finally 恢复；不能靠夹具绕过被测生产链路。contextBridge 的 `window.pi` 只读，不要指望赋值替换 IPC 来注入失败。
- **断言有效性**：异步操作等待实际完成屏障，不用固定 sleep 判断落盘；断言应能被反例击穿。环境不满足和业务断言失败分开报告。
- **性能**：固定样本、窗口和阶段，区分首次挂载、切会话、真实滚动补挂、图片解码；不要把模块基建堆占用全部算成会话成本。

## 原生窗口的特殊边界

- 持久化窗口位置/尺寸用 `getNormalBounds()`，不要把最大化尺寸写成下次普通窗口尺寸；退出前需同步兜底保存。
- macOS 首次 show 可能改写 x 坐标，恢复位置后要核对实际 bounds；窗口事件使用现有 `resize` / `move` 接线，不假设 macOS 会发 `resized` / `moved`。
- macOS 关窗是隐藏，退出才释放应用；Windows 退出确认不能无限依赖 renderer 应答，保留超时放行，防止页面卡死后无法退出。

## 常见定位入口

| 现象 | 先看 |
|---|---|
| 流式白屏/卡死 | console、renderer-watchdog、事件 trace；稳定 selector 与导入环 |
| 页面状态难复现 | `scripts/replay-trace.mts`，需要 UI 时用 `repro-full.mjs` |
| 切会话卡顿或上滑被拉回 | `MessageList.tsx`、`mount-window.ts`、浏览器滚动锚定；不要叠加多套补偿 |
| 浮层 rect 正确但显示不全 | mask 裁绘与 portal，见 [UI 规范](ui.md) |
| 带图发送后短暂空白 | 乐观用户气泡与附件预缩放，见 [SDK 集成](sdk.md) |
| 历史图成本或占位跳动 | `check-history-images.mjs`、历史图片资源层；必须覆盖 build 的 file:// 与 worker 链路 |
