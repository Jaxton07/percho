# 用户级 Provider 启动协议

## 零会话启动

后端 `init()` 使用 SDK 的 `createAgentSessionServices()` 加载用户级资源，消费工厂的普通配置式和原生 `pi.registerProvider(...)` 注册，然后等待本地快照和一次在线目录刷新。此过程不创建 `AgentSession`、不写会话文件，也不发送或伪造 `session_start`。

资源加载固定使用 `projectTrusted: false`，不因会话的自动信任选项而加载启动目录中的项目扩展。用户级扩展本身是受信任代码，并非沙箱；其工厂应避免启动会话专属后台任务。

用户级包安装、卸载成功后会重新加载这组资源，即使当前没有会话。重新加载先撤销旧代，再加载新代。文件外部编辑不会自动触发文件监视；需要重启或由宿主触发资源重载。

## 显式生命周期 v1

需要异步宿主初始化的扩展，在工厂执行期间发出版本化事件：

```js
export default function (pi) {
	pi.events.emit("percho:provider-activation:v1", {
		version: 1,
		id: "example-provider",
		async activate(runtime) {
			runtime.registerNativeProvider({
				id: "example-provider",
				name: "Example",
				auth: {},
				getModels: () => [],
			});
			return {
				deactivate() {
					runtime.unregisterProvider("example-provider");
				},
			};
		},
	});
}
```

这个例子只展示生命周期，不包含认证或推理实现。真实目录扩展应实现原生 Provider 的 `refreshModels(ctx)`，遵守 `ctx.allowNetwork`、`ctx.signal`，通过 `ctx.publish(...)` 发布目录；不能把离线请求当作清空已有目录的指令。

- `activate(runtime)` 可以异步，但必须返回具有 `deactivate()` 的句柄。`deactivate()` 可以返回 Promise，应停止扩展自己的监听器、定时器和请求。
- `runtime` 提供 `getRegisteredNativeProvider/getRegisteredProviderConfig` 查询原生注册，并提供 `getProvider/getProviders/getModel/getModels/getAuth`、`registerNativeProvider/registerProvider/unregisterProvider/refresh` 以及只读 `signal`，不是完整的会话上下文。
- 注册只能使用声明中的 `id`；多个 Provider 应分别声明。重复声明、与现有 Provider 冲突、缺失句柄、激活失败均拒绝本代并撤销已经拥有的注册。
- 不要在 `session_start` 中重复注册同一个 v1 Provider，也不要在单会话关闭时撤销宿主级 Provider。会话资源加载时仍会执行工厂，但没有此宿主事件监听器，不会重复激活 v1。
- 句柄及其闭包只属于当前代。撤销同步 abort 并移除仍由本代拥有的实例，之后的注册与刷新会被拒绝；已经排队的刷新 caller 也立即拒绝，避免 `deactivate()` 等待它时与重载形成循环。队列与 `join()` 仍等待已经执行的工作完成，不因 caller 取消而提前放行后继任务；清理不能重新注册以复活旧代。
- 使用 `runtime.signal` 取消自己的异步任务。工厂没有强制取消接口，`activate` 和 `deactivate` 也必须合作取消；宿主等待自己的加载与清理 flight，不承诺对任意扩展代码有界停止。

## 刷新与失败

启动等待目录刷新返回后才完成。目录失败（例如 503）不阻止后端启动：Provider 身份仍可存在，模型目录可能为空或沿用扩展缓存。后端 `getProviderStartupDiagnostics()` 返回 `{ phase: "catalog", providerId }`，不会暴露凭证或原始上游错误内容。此方法是后端诊断入口，目前没有新增 IPC/UI 展示通道。

`settings.listProviders({ forceNetwork: true })` 显式刷新可恢复目录，并更新诊断。默认列表读取仍为离线刷新。宿主队列协调设置页刷新和用户资源加载，避免本地刷新取消显式在线目录发布。刷新始终覆盖全部 Provider，保留其他 Provider 的 `filterModels`；不修改 SDK 的通用刷新实现。启动在本地刷新后调用 `settleRegistrationRefreshes()`，等待注册/注销隐式触发的离线刷新完成，再开始在线目录发布，避免迟到的配置读取取消在线结果。`activate()` 内等待 `runtime.refresh()` 不会排到它自己的加载任务之后。

启动的在线目录刷新传入 8 秒取消信号；这不是对不遵守信号的扩展工厂、激活函数或清理函数的硬超时。资源工厂加载或注册失败是启动失败，不等同于可降级的目录失败；初始化 Promise 会清除，可在修复资源后重试 `init()`。事件总线没有声明来源信息，因此任一工厂失败时保守拒绝整代激活。

## 兼容边界

普通工厂注册继续走 SDK 原生 services 路径，不要求采用 v1；只依赖 `session_start` 的旧扩展则不能自动获得零会话激活。重复普通注册 id 在宿主注册前拒绝，避免静默覆盖。

普通扩展仍可能在真实会话创建、重载或事件处理时重新注册。固定 SDK 的补丁沿 services、runner 和 session 注册入口保留 `extensionPath`，由 `getRegisteredProviderSource(id)` 查询。用户资源清理接受原实例或同一扩展路径的替换实例，因此创建会话后卸载无关包不会误判冲突，卸载自身也会移除同源注册。不同来源或未标记来源的替换仍受保护，普通重复 id 检查不变。来源路径用于生命周期归属，不是受信任扩展的安全沙箱；任意跨来源抢占、旧会话持续主动重注册和后续会话刷新互斥不在本协议保证范围内。需要强生命周期保证的扩展应使用 v1，不要同时使用普通或会话注册路径。

SDK 版本仍固定为 `1.4.0`。既有 `patch-package` 补丁仅新增上述来源传递及 `settleRegistrationRefreshes()`：跟踪三个普通注册/注销入口已启动的隐式刷新，并汇报其异常；不新增全局 FIFO、不遍历私有字段、不使用睡眠或固定次数重试，也不改虚拟模型、推理、认证或通用 `refresh()` 的并发/重入语义。既有会话补丁保持不变。

本协议管理 Provider，不承诺管理 SDK 虚拟模型注册或工厂任意副作用的生命周期。用户资源重载后空闲会话仍遵循既有重载逻辑，忙碌会话仍跳过。单会话关闭不撤销共享 v1 Provider。

## 定向验证

```sh
npm exec --workspace @percho/backend -- vitest run test/provider-startup.test.ts test/provider-startup-regressions.test.ts test/model-refresh.test.ts test/session-shutdown.test.ts test/packages-admin.test.ts
```

测试使用真实 `PiBackend`、资源加载器和 SDK，隔离 HOME、agent、临时目录并使用合成认证及 fetch 替身，不调用真实模型。安装测试仅替换包传输/持久化，保留真实包管理后续重载路径；不会访问外部包仓库。全量测试及跨平台集成应另行执行。
