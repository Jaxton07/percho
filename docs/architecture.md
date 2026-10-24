# 架构与数据边界

适用于跨模块改动、会话状态和 IPC 设计。具体函数行为与默认值以源码、测试为准；模块入口见 [开发导航](INDEX.md)。

## 包与进程

- `packages/shared`：跨进程契约、共享纯函数、消息 reducer；不依赖 Electron 或 React。
- `packages/backend`：纯 Node 的 pi SDK 生产适配边界。`pi-backend.ts` 是门面，内部模块也直接使用 SDK，不要求所有 SDK import 挤在一个文件。
- `packages/desktop`：Electron main 装配 backend，preload 暴露 `window.pi`，renderer 使用 React + Zustand。SDK 运行在 main 内，不是独立后端子进程。
- LAN 页面复用 shared 消息投影，出网事件必须经过 backend `lan/sanitize.ts`；不要另造一套消息状态机。

## IPC 与扩展边界

新增 invoke 在 shared `ipc-channels.ts` 对应域表定义，并在 desktop `main/ipc/` 域 handler 实现；新增订阅在同文件 `SUBSCRIPTION_TABLE` 定义。PiApi 与 preload 从表派生，事件来源和信封转换仍由 main 显式接线；发送复用 `main/ipc/send.ts`，不绕过载荷类型检查。

执行方法与本机原生方法的作用域也由原契约表定义。环境调用在入口绑定已登记的目标身份，不读取可变的“当前后端”；环境身份变化或连接脱离后拒绝原请求，不能回落本机。事件保留所属环境，兼容期旧订阅只接本机事件。UI复合引用不改写SDK原始ID或JSONL，跨环境解包必须核对归属；不得把路径或会话裸ID当作跨机器唯一身份。

preload 保持 CJS 与 sandbox 兼容。生产相对导入图三域无环；纯函数与常量放叶模块，不放在会反向导入其消费者的 store 或 barrel 上。

UI 插件的槽位/区域标识以 shared `ui-plugins.ts` 为单源。新增对插件公开的 hook/store 时，同步核对 renderer `plugins/host-api.ts`、`env.d.ts`、main `ui-plugins/build.ts` shim、发布的 `resources/ui-plugins/percho-ui.d.ts` 与 SPEC；使用现有契约守护测试，不手抄第二份 API。

## 会话数据不是一张表

| 数据 | 权威与用途 |
|---|---|
| 持久化会话树 | SDK SessionManager / JSONL：完整当前分支历史，含压缩条目 |
| 模型上下文 | SDK projection：给模型看的有效消息，可能已压缩；不能用它重建完整 UI 历史 |
| backend registry | 当前在册的 SDK 实例与资源所有权，不代表所有历史会话 |
| renderer `sessions` | 已加载会话的运行态；GC 可以移出，不决定导航行是否存在 |
| renderer `projects.allSessions` | 会话目录：磁盘对账 + 本进程新会话写穿；作为导航存在性来源 |
| renderer `session-workspace` | 顶栏胶囊和轨道的有序成员；独立于内存加载状态与置顶偏好 |
| renderer `pinnedSessions` | 左栏长期收藏与组内置顶，不决定顶栏成员或工作区顺序 |
| renderer `transcript` | 历史回放 + 实时事件的 UI 投影，不直接修改 SDK 上下文 |

因此：GC 不应让左栏行或工作区胶囊消失；胶囊的 × 是移出工作区，不是 close/delete/abort/unpin；只读子代理会话从导航投影中过滤，不能从运行态直接删掉。

会话时间以 header 和 user/assistant 消息时间为准，不用文件 birthtime；合并内存与历史 meta 时，不能用不完整的内存字段覆盖权威时间，造成排序漂移。

## 导航、装载与草稿

- `session-navigation.ts` 持导航令牌；异步返回只在意图仍有效时提交焦点。启动恢复还需检查用户是否已经接管，不能抢回页面。
- `session-loading.ts` 负责共享 open/bundle 单飞和数据落地，不拥有焦点或工作区成员；跨 await 重新核对身份，不缓存 store 快照来覆盖新状态。
- 完整历史落到 UI 后才发 history-ready ACK；打开期间实时事件抢先到达，不等于历史已完整，需由 `session-history.ts` 协调补拉。
- 新会话页同一时刻只有一份活动 draft 配置；`activeSessionId === null` 时必须有 draft，兼容 `cwd` 镜像 draft.cwd（包括 null）。配置捕获环境归属，输入不能跨环境共用；首发 promotion 使用入口快照并按 draft 代次单飞，改变目标必须换代，迟到结果可以入表但不能抢新意图的焦点。远端权限以后端真值为准，不能从UI持久偏好恢复fullAccess。
- 输入正文使用 shared 中立文档，Lexical 的节点与撤销状态只留在 renderer 编辑宿主。同一草稿切换只解绑 DOM，真实会话卸载/关闭才释放编辑器；未发送草稿仍只保存在本次运行内。发送快照、在途锁与拒绝提示按目标草稿保存，不能放在会随空态/列表态重挂的组件内；拒绝时已有新编辑则显式恢复旧快照，不覆盖新内容。
- 当前目录统一由 `lib/active-cwd.ts` 派生；宿主提交状态时从最终 patch 计算兼容 cwd，不用订阅补写制造中间态。
- “空集合是有效选择”和“尚未初始化”分开表达，例如左栏全部折叠不能因 `[]` 而回退到默认展开。

## 生命周期与异步写入

- backend open 按规范化路径单飞，registry 拒绝静默覆盖。普通关闭、应用退出、注册冲突的资源所有权不同；不要合成一条不分语义的清理路径。SDK shutdown 特例见 [SDK 集成](sdk.md)。
- 频道订阅表示明确驻留：自动 GC 不卸载有有效订阅的会话；保护快照读取失败时跳过整轮，而不是冒险卸载。订阅快照以 generation/revision 拒旧，空 topic 集合不等于实例已关闭。
- settings 按消费者加载，不因打开任意设置页就读取所有域；全局权限门读取保持独立。变更后刷新复用原有世代仲裁，不建第二套缓存或请求排序。
- JSON 持久化复用 `JsonStore` 的原子写与串行 update；队列外先取旧快照、排队后再写，会覆盖更新。异步扫描/构建发布也要检查条目身份，不能复活已删除插件。
- 改并发流程时用可控 Promise/完成屏障验证乱序、失败、关闭后重开；不要依靠固定 sleep 或放宽断言掩盖竞态。

## 用户数据与安全

正式 agent 数据在 `~/.pi/agent/`，与 CLI 共享；开发/预览通过 `main/dev-agent-dir.ts` 隔离到 `~/.pi/agent-dev/`，Electron userData 使用 `-dev` 后缀。具体开发路径与实例管理见 [UI 调试](ui-debugging.md)。

权限模式属于会话，不是改写全局权限规则；第三方扩展的通用 confirm 不是工具授权。MCP/第三方工具无只读声明时不能默认放行，求值链以 backend `permissions/` 为准。

凭证不写入文档、日志或测试夹具；重放和验收使用隔离数据，不把正式目录当可变测试环境。

Renderer 中项目目录与日常空间也使用带环境的身份键，只有展示或发往已绑定执行入口时解码；不能将它当成本机路径做 IO。目录刷新世代、最后可信快照和 GC 的频道保护按环境隔离，远端失败不等于空目录，也不阻塞本机回收。旧 `ui-state.json` 与手动项目 localStorage 只保存本机引用，混合工作区偏好使用独立持久化边界。
