# Windows 更新诊断与恢复

## 这次补齐什么

针对 #104（0.6.3 → 0.6.4 自动更新失败）补可观测性，不宣称已经修复该故障的唯一根因。

- Electron updater 的专用日志 `userData/update-diagnostics/updater.jsonl`：版本/OS/可执行文件与临时目录、检查/下载元数据、SDK 下载/校验/安装启动日志、交接请求、退出事件、异常。512KiB 轮转，保留上一份；同步写盘，不依赖 app 退出后的 async flush。
- `install-attempt.json`：安装前记录来源/目标版本、触发方式与请求 ID；下次启动观察目标版本是否运行。**尚未观察到目标版本 ≠ 安装失败**，异常退出时 updater 也可能跳过自动安装。
- Windows NSIS 新安装器的 `%LOCALAPPDATA%\Percho\update-diagnostics\nsis.log`：UTF-16LE，stage/PID/系统 tick/构建版本、模式、updated/force-run 类别、当前目标目录、旧卸载器返回码/启动错误、对应注册表旧目录与卸载命令、临时旧卸载器位置。初始化的目录和模式还可能被向导改变，不能视为最终值。
- 设置 → 关于 → **导出更新诊断**：用户自行选择 JSON 文件，合并专用 updater/NSIS 日志和当前环境；Windows 附只读相关进程路径、Percho 卸载登记、最多 10000 文件的长路径样本。只采 Name/PID/父 PID/可执行路径，不采 CommandLine、进程环境、认证文件或会话；不上传。路径可能含用户名，分享前须检查。
- 设置 → 关于也有官方安装包入口、手动恢复说明。NSIS 卸载失败的最终弹窗保留原错误与 exit code，并给出诊断路径（目录可写时才有文件）。

## 对已有旧包的生效边界

新的诊断安装器即使调用的是旧包卸载器，也能在新安装器侧记录其最终退出结果；但旧卸载器内部的失败文件/操作不可追溯补写。已发布的 0.6.3/0.6.4 本身没有这些诊断，不能凭空产生历史日志；需下一诊断构建/版本参与该链路。

“Percho 无法关闭”是 electron-builder 重试旧卸载失败时也会复用的文案，**不是主进程仍存活的证据**。旧卸载器返回 2 不是 Windows 系统错误 2 的直接等价。结果 hook 在旧卸载步骤最终返回后才执行，循环中可能尚无结果行；取消本次安装后保留日志，不无限重试。

- 自动升级退出后，app 不能观察外部 NSIS 弹窗；应用内 `error` 只覆盖 SDK 已上报的下载/启动错误。
- 用另一管理员账号提权时，NSIS trace 可能位于该管理员的 LOCALAPPDATA，应用侧会显示未取得；请按失败弹窗路径取文件。
- 导出的 Windows 快照是**导出当时**的状态，不证明故障发生时没有占用；读写打开文件也不证明能重命名/删除。
- PowerShell/CIM 被策略拒绝、无权限或采集超时：导出仍保留已有日志并记录采集异常，不调整系统策略。

## 用户恢复（先保留证据）

1. 保存弹窗截图、原版本、安装范围/完整目录以及 TEMP 路径；取消本次安装。
2. 若仍能启动旧版且支持诊断导出，先从“关于”导出；否则按弹窗路径保存 NSIS trace。旧版本没有 trace 时如实记录“无日志”。
3. 退出安装器与 app，重启 Windows，再从官方 Release 下载对应安装包，保持原安装范围。
4. 仍失败时先备份 `~/.pi/agent` 及应用 userData，再通过系统设置正常卸载/重装；不要手删用户数据、注册表或绕过旧卸载器。
5. 已通过其他方式升级成功的用户，不要为调查直接降级现有环境。复现在 VM/隔离设备进行。

## 进一步定位具体失败文件

使用 Microsoft Process Monitor，捕获一次官方“旧包 → 新包”更新，过滤旧卸载器 `old-uninstaller.exe` 与新安装器 PID，观察文件重命名/删除、失败 Result 与 Process Exit。保留错误前后的成功操作，不只过滤所有非 SUCCESS（正常探测也会失败）。文件占用/权限/长路径须结合实际操作判断。PML 可能含更多个人路径，不应未经检查上传。

## 工程验证与守门

- `update-diagnostics.test.ts`：跨重启观察语义、同步交接、轮转/中文 trace、脱敏/不采会话凭证、真实不可写 IO 不阻断。
- `updater.test.ts`：SDK logger、显式/退出时交接、native before-quit-for-update、退出/异常、旧 UI policy 保持；dev 不启动自动更新。
- `UpdateHelp.test.tsx`：用户显式导出、取消/失败 toast、隐私说明、官方链接与未确认提示。
- `node scripts/check-windows-update-diagnostics.mjs`：编译真实 include；Windows 上执行 success/HKCU/launch-error/nonzero/日志不可写 harness，比较 stock Errors/寄存器/exit 语义，真实 PowerShell 只读 JSON 快照。仅 harness 把 MessageBox 改为 DetailPrint 防阻塞，生产仍保留原失败退出。
- CI Windows job 还编译真实生产 NSIS（含全套实际变量/flags/header），不只编译 mock hook。升级 electron-builder 必须重新核查 handleUninstallResult 的 hook 替换契约。
- 当前 macOS NSIS 编译器在最小 IfErrors 脚本也出现 std::bad_alloc，不能作为 patch 编译证据；Windows CI 编译/执行为准。完整 Windows 原始故障复现仍是后续根因修复的门，不把诊断 harness 当成根因已解决。

## 不做什么

不改变下载/自动安装策略，不跳过进程检查，不强行覆盖文件、不删卸载登记、不强杀进程、不改认证/会话数据、不改 SDK；不在 0.6.4 已发布 tag 上覆盖安装包。
