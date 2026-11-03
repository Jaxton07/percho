# 发版流程

以后发版从本页开始。操作前应已有明确发版授权；构建内部约束、签名和包内资源问题查 [构建与验包](build-release.md)。命令在仓库根目录逐段执行，失败即停止，不忽略退出码。

主流程：**确定提交和版本 → 提前写好说明并创建草稿 → 推标签 → 等一次 Release workflow → 核对公开结果**。不需要先在本机打全平台包，也不需要手工上传安装包。

## 1. 确定版本和源码

- 变更已通过 PR CI 并合入 main，工作区干净；目标提交若已有 CI 失败，先解决。未通过的专项验收不能用“打包成功”代替。
- 使用唯一的新版本：正式版 `X.Y.Z`，内测 `X.Y.Z-beta.N`，候选版 `X.Y.Z-rc.N`。不复用已经发布的版本。
- 发版版本由标签传入，统一写入桌面包、更新文件和 SSH 运行包，**不必为发版修改 package.json 的开发基线版本**。

以下 `0.6.8` 仅为命令示例，先换成获准发布的版本。后续始终使用同一个完整提交 SHA，不依赖当前分支的 HEAD。

```bash
release_version=0.6.8
release_tag="v${release_version}"
release_dir=".local/tmp/release-${release_version}"
mkdir -p "$release_dir"
gh auth status
git status --short
git fetch origin main --tags
release_sha=$(git rev-parse origin/main)
gh run list --workflow ci.yml --branch main --commit "$release_sha" --limit 1
gh api repos/Jaxton07/percho/releases/latest --jq .tag_name
```

main CI 尚在重复打包时可并行启动 Release；无需另触发或等待一次 main 打包，但 Release 自己的检查和正式验包不能省略。

记录上一个正式版为 `previous_tag`，核对改动范围：

```bash
previous_tag=v0.6.7
git log --oneline "${previous_tag}..${release_sha}"
git ls-remote --tags origin "refs/tags/${release_tag}"
gh api --paginate repos/Jaxton07/percho/releases --jq ".[] | select(.tag_name == \"${release_tag}\") | {id, tag_name, draft, target_commitish}"
```

标签和发行均应不存在。已有记录时先核对来源与状态，按下文恢复，不强制覆盖。查重必须包含草稿：按标签查询返回404，不足以证明不存在尚未关联远端标签的草稿。认证或网络失败也不能当作“不存在”。

## 2. 提前写说明并建立草稿

将说明写入 `$release_dir/notes.md`，在触发构建前完成核对。说明覆盖上个版本以来的全部用户可见变化，不能只写最后一个 PR。

正文沿用英文，参考 [Pi release note](https://github.com/earendil-works/pi/releases/tag/v1.5.0) 的分类：`New Features`、`Breaking Changes`、`Added`、`Changed`、`Fixed`、`Removed`，只保留有内容的小节。开头突出少量主要变化，细项关联 PR；核对贡献者署名，明确兼容性、迁移和使用限制，不把局部测量写成所有平台的性能保证。末尾保留本版的 Full Changelog 比较链接。

```bash
gh release create "$release_tag" --draft --target "$release_sha" \
  --title "$release_tag" --notes-file "$release_dir/notes.md"
```

Beta/RC 在上述命令加 `--prerelease --latest=false`。创建后确认草稿的 `target_commitish` 是选定的完整 SHA、正文完整。草稿不手工公开、不手工上传资产；它可以先于远端标签存在，页面URL也可能显示 `untagged`，以 `tag_name` 和源码字段为准。现有发布脚本只复用同一提交的草稿，保留其正文，完成验包和上传后才公开。命令与参数说明见 [GitHub CLI](https://cli.github.com/manual/gh_release_create)，草稿行为见 [维护者说明](https://github.com/cli/cli/issues/11589)。

## 3. 推标签并等待一次发布流程

```bash
git tag -a "$release_tag" "$release_sha" -m "Release ${release_tag}"
git push origin "refs/tags/${release_tag}"
gh run list --workflow release.yml --branch "$release_tag" --limit 1 \
  --json databaseId,headSha,status,url
```

取这次运行的 `databaseId` 为 `release_run_id`，确认 `headSha` 等于 `release_sha`；列表尚未出现时短暂等待后再查一次，不重复推标签或手动触发第二次发布。

```bash
release_run_id=替换为本次运行编号
gh run watch "$release_run_id" --interval 30 --exit-status
```

只保留一个观察进程，不同时反复查询 job、读取观察日志和启动多个 watch。检查失败时定位失败任务，状态不变时不重复汇报相同信息。

[Release workflow](../.github/workflows/release.yml) 自动完成检查、两种 Linux SSH 运行包的构建与离线验收、三平台桌面打包和隔离启动验收。随后 [发布脚本](../scripts/publish-release.mjs) 校验整套产物的版本、来源、大小和摘要，全部上传到草稿并确认完整后才公开。

正式版设为 latest，保留稳定下载名和更新源，并触发官网刷新；Beta/RC 为 prerelease，不成为 latest、不刷新正式官网。hook 未配置时任务会明确跳过；hook成功只表示刷新请求成功，不等于官网已经完成部署。

当前 Release 仍会执行自己的检查，尚未实现复用 PR/main CI 的结果，不能手动跳过。发版期间无需再在本机重复运行同一提交已通过的整套测试；正式版仍必须重新构建验包，不能直接发布 PR 的 Beta 安装包。

## 4. 核对公开结果

workflow 全部成功后做一次公开侧核对，不再次下载整套安装包重复验包：

```bash
gh api "repos/Jaxton07/percho/releases/tags/${release_tag}" \
  > "$release_dir/published.json"
gh release download "$release_tag" --dir "$release_dir/verify" \
  --pattern 'release-*.json' --pattern 'runtime-linux-*.json' \
  --pattern 'SHA256SUMS-*.txt' --pattern 'latest*.yml'
```

逐项确认：

- `published.json` 的标签、目标提交和正文正确，`draft=false`；正式版 `prerelease=false`，且 `/repos/Jaxton07/percho/releases/latest` 返回本版。Beta/RC 则确认 prerelease 且未改变正式版 latest。
- 三平台 `release-*.json` 为本次版本、同一源码提交，`passed=true`、`mode=release`；两份运行包元数据也指向同版同提交。
- 每份报告列出的资产都已上传，GitHub 资产的 `size`、`digest` 与报告中的字节数、SHA256对应；两份 SSH 归档同样与各自元数据一致。摘要缺失或不一致时再下载相关资产取证，不把缺失当作通过。
- 正式版的 `latest.yml`、`latest-mac.yml`、`latest-linux.yml` 均指向本版，报告列出的安装包、更新文件、摘要和运行包齐全。预期资产以 [整包校验逻辑](../scripts/release/bundle.mjs) 为准，不硬编码资产总数。

公开前的字节和摘要验证已由发布脚本执行，公开侧只核对小型报告和资产元数据。核验通过后记录发行链接、源码提交和 workflow 链接即可。诊断文件留在忽略的任务目录，不提交下载产物、凭据或本机数据；本次启动的测试进程应全部退出。

## 异常与恢复

- **构建或验收失败**：用 `gh run view "$release_run_id" --log-failed` 定位原因。相同提交、相同草稿可用 `gh run rerun "$release_run_id" --failed` 重试；不要例行删除草稿或标签。修复代码需要新提交和新版本，重跑旧标签不会取得新代码。
- **上传失败**：保留同提交的草稿，按发布脚本恢复。不要中断正在上传的 publish 任务，不手工公开半套资产，也不把别的提交的产物补进来。
- **已经公开**：发布脚本拒绝覆盖公开发行，不能整条重跑以替换安装包或更新文件；二进制问题发新版本。
- **只有说明需要修正**：用 `gh release edit "$release_tag" --notes-file "$release_dir/notes.md` 更新正文。正式版再从运行详情找到 website 的 job ID，保存为 `website_job_id`，用 `gh api --method POST "repos/Jaxton07/percho/actions/jobs/${website_job_id}/rerun"` 单独刷新官网，不重跑 publish。
- **只有官网刷新失败**：单独重跑 website job。不要因此重新发包；hook未配置则记录未触发，不宣称官网已更新。

## 只要内测包时

无需公开发行时，手动运行 Release，指定测试版本并保留 `publish=false`；完成后从 Actions 下载产物，不创建额外发行，也不触发官网刷新：

```bash
gh workflow run release.yml --ref main -f version=0.6.8-beta.1 -f publish=false
```

手动构建也要核对实际运行的源码提交。若要公开 Beta/RC，使用上面的草稿与标签主流程。需要本机调试包才进入 [本地构建](build-release.md#本地-macos-内测包)，不把本机调试打包加进每次正式发版。
