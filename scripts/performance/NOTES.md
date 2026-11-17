# 性能运行隔离协议

新入口在规范的仓库路径 `.local/test/performance/<run>` 下创建独立 run，并在 `owner.json` 写入 `{version: 1, kind: "percho-performance-run", owner: UUID}`。CLI 将规范绝对路径 `PERCHO_PERF_RUN_DIR`、相同的 `PERCHO_PERF_OWNER` 传给所有子进程。夹具和宿主均位于 `run/work/`；渲染按采集模式分子目录，switch/images 共用 `run/work/switch`。会话切换诊断仅接受这个 switch 根，并要求 agent 和 userData 位于其中。

私有 host 必须验证规范仓库路径后向 Electron 传入 `PERCHO_PERF_SOURCE=<canonical repo>`，并验证、透传 run 和 owner；不能从复制到临时 host 的编译模块路径推算仓库。未提供 source 时 main 从 `cwd` 为 `repo/packages/desktop` 推导。旧版默认目录仍可独立运行，不需要 marker。

marker 用于避免误连接、误写和跨 run 混用，不防御恶意本地用户，也不允许连接正式 agent。
