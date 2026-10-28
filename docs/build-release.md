# 构建、打包与验包

仅在构建/发布相关任务阅读。依赖版本、平台目标和脚本以根及 desktop 的 package.json、`packages/desktop/electron-builder.yml`、`.github/workflows/` 为准，不在文档维护完整配置副本。

## 常规检查

根目录：`npm run typecheck`、`npm run test`、`npm run lint`、`npm run build`。

保留命令真实退出码，不用 `npm run lint | tail -2` 判断通过。环境问题、已有失败与本次回归应分开记录；重跑一次成功不能证明竞态已修好。

## 本地 macOS 内测包

内测使用独立的 `Percho Beta` 身份与橙色 BETA 角标，不改版本、不打 tag：

```bash
cd packages/desktop
npm run dist:beta -- --mac dmg --arm64
```

**必须先 build。** dev 的 renderer 在内存中，直接打包可能把磁盘 `out/` 的旧 renderer 装进去，即使 main 已经是新代码。

当前 yml 的 mac target 同时列出 arm64/x64，不能仅凭 CLI `--arm64` 推断只会生成一种架构；检查实际产物。Beta 产物位于 `packages/desktop/dist/beta.noindex/`。正式发布仍用 `npm run dist`，不要把 Beta 包上传为正式安装包。

三套名称与应用标识以 `packages/desktop/build/app-channels.json` 为准：正式版 `Percho` 无角标；内测版 `Percho Beta` 带 BETA 角标；开发版 `Percho Dev` 带 DEV 角标。Beta 与开发版不连接正式更新源，后续测试版本手动安装。数据目录和首次启动行为见[用户级数据隔离](local-agent-storage.md)。

更新 `build/icon.svg` 后，运行 `npm run icons -w packages/desktop` 同步生成三套 PNG 与通道 SVG。macOS 的开发入口会缓存一份独立 Bundle ID 的 Electron 外壳，并临时签名，不改 `node_modules` 中的 Electron；正常 `npm run dev` 会自动使用它。生成图标需要能启动 Electron 的桌面环境，已生成的图标随仓库保存，常规 CI 打包无需启动图标生成器。

当前 adhoc 包未公证。首次打开可能需要用户右键“打开”或移除 quarantine。新 Beta 可以与正式版并存；此前名称仍为 `Percho` 的旧内测包使用正式身份，不能继续按并存方式使用。冒烟后退出测试包。

## 验包看实际产物

在仓库根目录用一个新的任务子目录解包：

```bash
npx asar extract packages/desktop/dist/mac-arm64/Percho.app/Contents/Resources/app.asar .local/tmp/package-review/app
```

然后检查其 `out/main/`、`out/preload/`、`out/renderer/assets/` 中本次改动的实际代码。不能只凭构建时间或 main 新字符串证明 renderer 已更新。

不要在仓库根使用 `asar extract-file`，它会把文件按 basename 解到当前目录；不使用 `/tmp`。同一验包目录不要混入上次产物。

## 必须保留的构建边界

- preload 输出 CJS `index.cjs`；sandbox 下不能随意改成 ESM。
- main 的 workspace backend/shared 需按现有 Vite 配置打入 bundle，避免被 externalize 当普通外部包；SDK 保持既有 external 边界。
- electron-builder 从 desktop 依赖树收包，需要的生产依赖不能只放根 devDependencies。Electron 使用精确版本。
- `PI_PACKAGE_DIR` 指向随包 `pi-package`，相关 docs/examples、主题和导出资源需一起带入；不要只复制文档漏掉运行时资源。
- esbuild 等需要 spawn 的二进制不能在 asar 内执行；保留 `asarUnpack` 和 `ESBUILD_BINARY_PATH` 处理。
- 项目要求 Node >=22.19；Electron 二进制缺失时先核对安装脚本授权与依赖安装日志，不要改应用代码绕过。
- Release 构建出现 V8 heap OOM 时检查 workflow 的 Node 堆上限；这是构建峰值，不是应用运行时内存。别把 Rollup annotation warning 当根因。
- `patches/` 由 patch-package 在 postinstall 应用。修改依赖后更新补丁，升级依赖时重核官方实现与补丁必要性。

## 发布与平台验证

本机维护者的 tag、签名、网络等操作见 `.local/docs/release.md`（不入库）；文件不存在时从仓库 workflow 和 builder 配置核对，不猜发布步骤。未经用户明确要求不 push、不创建发布或覆盖已发布资产。

Windows 更新诊断及旧卸载器边界见 [WINDOWS-UPDATES.md](WINDOWS-UPDATES.md)。NSIS 改动须用 Windows CI 的真实 installer 编译和隔离 harness 验证，macOS 上的编译结果不能替代 Windows 行为证据。

## SSH 运行包

远端默认根为 `~/.percho/`：`agent/` 保存配置、凭据、扩展与会话，`releases/` 保存不可变运行包，`staging/` 为安装暂存，`run/` 保存私有socket和锁，`logs/` 保存服务日志。它与本机UI插件目录的归属不同，远端不会自动运行其中的桌面界面代码。

`build-remote-runtime.mjs` 只在目标 glibc Linux CPU 上构建；Node 外置，运行要求跟随已锁定SDK的最低版本 `>=22.19.0`，不限制22.x；glibc要求2.35+。Node范围单源位于 shared 的 runtime-node-policy.json，预检、启动、清单与生产依赖声明共用；发行构建仍使用固定Node22.19基线。依赖从提交的锁文件中选出后在独立目录安装，应用 SDK 补丁；不把桌面 node_modules 复制过去。包保留 SDK worker/WASM、主题、文档、维护 CLI 和导出资源，固定摘要的 fd/rg 放包内 bin，不安装到系统。入口固定自身 SDK 资源根，不能继承其他 Pi CLI 的 PI_PACKAGE_DIR。

构建与仓库外验包由 `.github/workflows/remote-runtime.yml` 复用：目标容器内运行 `node scripts/build-remote-runtime.mjs --out <隔离产物目录>`；验包容器只挂归档、scripts 和私有 /state，关闭外网，执行 `scripts/remote-runtime/check-artifact.sh`。临时 /runtime 须允许执行包内搜索程序；不要把测试目录的 noexec 挂载误诊为工具缺失。验收覆盖主工具、用户扩展/MCP/子代理、两种 WASM 与图片 worker 无回退、完整导出、断线恢复和认证维护锁；CPU 仿真结果需标明，不能冒充物理目标性能或三桌面验收。

安装器另用 `verify-remote-runtime-install.mjs` 在隔离目标执行：挂载实际归档、原始 desktop bootstrap 与 scripts，使用可执行的私有暂存目录；验证成功安装及摘要、截断、架构、越界、并发失败保护。它不替代仓库外 SDK 验包。

两份验包产物经 `prepare-remote-runtime-manifest.mjs --input <同目录两份归档和摘要> --output packages/desktop/resources/remote-runtime/manifest.json` 生成桌面清单。生成文件不入库；打包前检查它与桌面版本对应，缺失时阻止打包。普通 renderer/main 构建仍可独立运行。公开发行流程先发布验过的运行包，再用 `--require-published` 核对固定官方 URL，之后才构建和上传引用它们的桌面；不读取任意 latest、不覆盖在用运行包，也不把本地生成清单当成资产已经公开的证据。未经用户授权不触发发布流程。

SSH 首次安装由桌面执行：先只读检测已有 Host 别名、Node >=22.19.0、glibc 2.35+ 与基础命令；已存在兼容服务直接附着，已装且停止的包按原版本启动，不读取新发行清单。缺包时按随附清单从固定官方 URL 下载到本机缓存并核对大小/摘要，展示版本及服务器私有安装目录，点击“确认安装并连接”才修改目标。后台自动连接缺包只提示，不代用户确认。开发态安装需要先生成资源清单，普通构建不会生成可信发行清单。

安装通过专用 SSH 上传归档：重新核验目标身份，持有安装锁与服务所有者锁，在私有随机暂存内逐项校验 ustar（只接受普通文件和目录，拒绝链接、越界、特殊权限、重复与超限），运行候选包离线检查，成功后原子发布不可变版本目录和 installed.json。候选未就绪不会被选作启动包；同版本不同摘要拒绝覆盖。中断可能保留私有 install-* 暂存，但不会自动执行它或清理旧包/agent 数据。它不是普通文件传输功能。

更新使用“停止远端服务”并取得退出证明，再检测、准备更新包并确认安装；新包启动失败保留旧包与 agent 数据，先查看私有 logs/runtime.log，不清空凭据或历史。若旧服务协议不兼容，桌面不调用猜测的旧停止接口：按目标端原运行目录执行同版 entry.mjs stop，再核验 wait-stopped；原服务仍被其他控制端占用时应回原桌面停止。OAuth/交互认证需在服务已停止时使用设置中给出的同版 auth 命令；远端凭据不从本机复制。

Node兼容验证区分最低运行版本与实测版本：Node22.19基线与Node26.12.1 x64实际包已通过隔离验证；Current镜像可用Dockerfile的NODE_VERSION参数构建，workflow同时复验同一归档。Node26官方Linux二进制还需要libatomic.so.1（Ubuntu包libatomic1），Node本身必须能在非交互SSH执行；Percho不自动修改系统库或升级Node。较新版本获准不等于所有未来Node版本已有实测证据。

开发期旧根 `~/.local/share/percho` 的迁移是一次明确的维护操作，不在连接时自动搬数据或绕过身份检查：先停止并确认所有者释放，备份后移动根目录；保留环境ID/UID并核对数据摘要，修正会话头/SDK按工作目录分组和本机导航中的目录元数据。正文条目及凭据不改写。需要保留历史绝对路径时可留旧根的兼容软链接，实际数据仅存新根；客户端仍只选择新根。会话分组目录不能另外留软链接，SDK会遍历链接而重复列出历史。测试包更换必须保留旧包，不能原位覆盖其摘要身份。
