# pi SDK 集成

适用于 SDK 接入、升级和生命周期/上下文问题。以下反直觉行为按当前钉住的 **1.4.0** 整理，升级时必须重核，不当作永久 API 保证。生产适配边界见 [架构](architecture.md)。

## 接入与资源所有权

- `pi-backend.ts` 是门面，`project/builtin-extensions.ts` 负责官方内置扩展接入；`Model` / `ThinkingLevel` 类型从 `@earendil-works/pi-ai` 导入。
- 扩展 UI 用 `session.bindExtensions` 注入，目前主会话绑定 `mode:"rpc"`，不依赖权限门开关。实际可用能力见 [扩展 UI](extension-ui.md)，不能宣称完整 TUI 兼容。
- **`AgentSession.dispose()` 不发送 `session_shutdown`**。官方 MCP 扩展依赖该事件关连接，单独 dispose 会遗留 stdio 子进程。复用 `session/shutdown.ts` 的公开 API 桥接，先 shutdown 再 dispose。
- 远端明确停服务先设置不可逆停止标记，取消构造中与已注册会话的等待交互、停止频道唤醒、清空队列并 abort；等待在途构造/请求和公开 `session_shutdown` 完成后再 dispose。清理失败或超时不宣称停止，专用服务的所有者文件描述符一直保留到进程真正退出，避免旧定时器在锁释放后运行。本机退出保留同步兜底。
- 普通关闭需等待清理并保留首错；退出钩子不等异步完成，必须有同步兜底；注册冲突只能拆掉新构造实例，不碰旧 holder。修改时核对 `session/registry.ts` 与现有 shutdown/dispose 回归，不依赖 app 最后退出替每个会话收尾。
- `before_agent_start` 按 `messageType` 区分用户与自定义起始消息，后者没有 `prompt`。启动处理期间会话已经 busy；取消可在实际请求开始前发生，传输层仍可能收到已取消的 signal，不能把进入传输回调当作已发出网络请求。
- `agent_settled.aborted` 表示取消；`agent_end` 之后仍可能自动重试、压缩或续跑。子代理完成和忙碌释放继续以最终 settled 为边界。

## 模型与工具

- `getAvailable()` 受凭证影响，可能是空数组，不能当完整模型目录；具体查询与目录刷新复用现有 runtime/settings 入口。
- `runtime.refresh()` 默认可能联网，本地读取应显式 `allowNetwork:false`；联网刷新由宿主选择时机并约束等待，不因普通列表读取隐式触网。
- Google Vertex 不接受 API key，使用 ADC/服务账号；OAuth/登录桥接复用 `settings/login.ts`，不要向用户提供已知必败路径。
- `createAgentSession({tools:[...]})` 的数组是允许清单，可能把扩展工具过滤掉；不要把“只想补几个内置工具”误写成不完整清单。
- 同名工具有不同优先层：`replaceable` 表示让位，双方非 replaceable 时同组先注册者胜，`customTools` 又可覆盖扩展工具。不要只调整 inline 扩展注册顺序来实现“内置优先”；复用 `tools/subagent/mutex.ts` 的既有方案。
- `getAllTools()` 属于工厂闭包的 `ExtensionAPI`，不在 handler 的 `ctx` 上；权限声明读取不要猜工具来源或默认信任 MCP。
- 工具参数 schema 保持顶层单 object；顶层 Union/Intersect 可能被 provider 拒绝。

## 持久化、上下文与回放

- 行内输入先把可读正文交给第三方 input，再由资源加载器最后注册的 Percho input 附加本次去重后的 skill 快照。受理上下文只活到 SDK 回执；排队使用 SDK 自带的完整载荷，不另存待执行关联表。公开 `message_end` 同角色替换在首次模型请求前移除签名临时尾部，同一 user 消息的 `perchoInput` 保存编辑器无关的原输入，content 保存本次实际模型正文。`before_agent_start` 仍可见展开正文及临时尾部，这属于兼容边界；请求、普通 UI、LAN 与 HTML 展示导出不得泄露尾部或把定义显示为用户正文。JSONL 保留真实快照，重试不重读资源，撤回重发则重新校验。升级时运行真实 SDK 生命周期测试，不能只凭类型推断这些时序。
- **`sessionFile` 是计划路径，不是已落盘证明**。SDK 可在创建时分配路径，首条会话消息后才写文件；判断磁盘存在性需实际检查。零消息会话可以在内存中合法改名，也可能不在磁盘 listSessions 结果里。
- UI 完整历史从 SessionManager 当前分支读取，不能读已压缩的 `session.messages`；todo 等历史工具结果也不能从压缩上下文恢复。
- compaction entry 可按分支顺序回放，但不保存触发原因和压缩后估值，历史 UI 不伪造这些字段。
- 请求上下文由 SDK projection 重建，手写 `agent.state.messages` 不构成可靠修改；撤回中绕过 `navigateTree` 的路径需要 `session.refreshContext()`，保持公开投影一致。
- 追加宿主系统提示要用 `appendSystemPromptOverride` 合并 SDK 发现的 APPEND_SYSTEM.md，而不是覆盖文件发现。主会话与子代理保持同一信任规则，回归见 `test/append-system-prompt.test.ts`。
- `sendUserMessage` 的 followUp 可能等当前 turn 结束才投递。跨会话唤醒不能把“已排队”当“对方已处理”，频道协作以 post、持久游标和恢复屏障为准。

## 流式、附件与压缩

- SDK 流式事件可能夹带累积全量快照。backend `session/event-slim.ts` 在单点瘦身，`stream-guard.ts` 负责异常流熔断，trace 自身也有体积边界；不要把巨量快照逐事件复制到 IPC/日志。
- 带图发送时 SDK 可能在构造 user message 前先缩放图片，导致 UI 等待。发送侧用 shared `transcript/pending-user.ts` 乐观回显，并由权威事件认领；附件在 renderer `lib/image-attachment.ts` 预处理，不伪造 SDK 用户消息。
- 压缩摘要也是模型请求，**其输入本身必须有界**，不能只依赖原会话的自动触发阈值。复用 `tools/compaction-guard/` 的百分比触发、输入上限和退避，不另造只看绝对余量的触发器。
- SDK 摘要序列化会移除全部 thinking 块，包括护栏生成的思考占位；护栏是否生效应验证工具结果截断、消息降级和输入上限，不能靠摘要包含思考占位判断。摘要输出使用模型输出上限，`reserveTokens` 仅控制触发条件。
- 压缩来源标记覆盖配对的开始/结束事件，不在更早的中间事件清理，否则结束文案会把自动覆盖成手动。
- 蒸发与压缩护栏各自拥有配置与纯函数核心；调参使用 `scripts/replay-evaporation.mts` / `replay-compaction-bound.mts`，不要复制一份近似线上算法来证明线上正确。

## SDK 升级清单

1. 核对依赖实际解析版本：`PI_PACKAGE_DIR` 可影响 SDK 导出的 VERSION，不能据它判断 node_modules 的版本；参考 `scripts/smoke-sdk.mts` 的 `import.meta.resolve` 检查。
2. 阅读目标版本类型与实现，重点核对扩展生命周期、工具优先级、上下文/压缩形状和持久化时机；typecheck 通过不代表行为未变。
3. 核对 `patches/`：当前 SDK 补丁提供 `retryLastFailedTurn`。升级先查官方是否已有等价入口，再评估补丁，不能悄悄丢掉能力。
4. 手动重试复用 SDK 原恢复生命周期，不重发用户任务，也不只调用底层 continue；验证失败响应身份、busy 状态与 live/replay 的定位一致性。
   当前补丁将起始消息准备与共享运行主体分开，手动重试不重新触发启动扩展；失败原文保留在会话树中，通过持久化上下文省略退出后续模型请求。选择记录、接受回调或省略失败也必须释放忙碌状态。
5. 跑 `smoke-sdk.mts`（升级后按实际版本更新口径）、全量 typecheck/test，以及相关专项冒烟；含真实网络/凭证的脚本先读文件头，不自动拿用户凭证执行。
6. 构建并核对随包 SDK 资源、preload 与原生依赖，见 [构建发布](build-release.md)。
