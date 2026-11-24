# 发版流程

本页可独立用于准备、发布和核验 Release；构建、签名与包内资源约束见 [构建与验包](build-release.md)。在仓库根目录逐段执行，失败即停，保留真实退出码。

**主流程：锁定版本和提交 → 说明与草稿 → 标签触发发布 → 公开核验。** 仅准备时完成只读预检和本地说明后停手；正式发布需明确版本授权，已有授权不逐步重复确认。只核验直接看第 4 节；修说明或恢复失败运行看“异常与恢复”。

## 1. 确定版本和源码

- 源码和模板变更提前通过正常 PR 流程合入 main，工作区干净。发版阶段只推获准的新标签，不临时直推 main 或绕过分支保护；已有 CI 失败或专项验收未通过时先解决。
- 正式版使用 `X.Y.Z`，内测使用 `X.Y.Z-beta.N` 或 `X.Y.Z-rc.N`；版本由标签统一传入，**无需改 package.json 的开发基线版本**，不复用已发布版本。

以下版本仅为示例，先替换为获准的版本；后续命令复用这组变量，跨 Shell 时从任务记录恢复：

```bash
release_version=0.6.8
release_tag="v${release_version}"
release_dir=".local/tmp/release-${release_version}"
mkdir -p "$release_dir"
gh auth status
git status --short
git fetch origin main --tags
release_sha=$(git rev-parse origin/main)
previous_tag=$(gh api repos/Jaxton07/percho/releases/latest --jq .tag_name)
gh run list --workflow ci.yml --branch main --commit "$release_sha" --limit 1
git log --oneline "${previous_tag}..${release_sha}"
git ls-remote --tags origin "refs/tags/${release_tag}"
gh api --paginate repos/Jaxton07/percho/releases --jq ".[] | select(.tag_name == \"${release_tag}\") | {id, tag_name, draft, target_commitish}"
```

查重包含草稿；已有标签或发行先按恢复表处理，认证或网络失败不能当作“不存在”。将版本、标签、完整源码 SHA、上个正式版及操作模式记入 `$release_dir/context.json`，后续追加草稿 ID、运行 ID。始终使用锁定的 SHA，不随 main 前进或当前分支 HEAD 改变；只在阶段切换和恢复时刷新状态。

## 2. 提前写说明并建立草稿

将说明写入 `$release_dir/notes.md`，覆盖上个正式版至锁定提交的全部用户可见变化：

- 正文用英文，按 `New Features`、`Breaking Changes`、`Added`、`Changed`、`Fixed`、`Removed` 分类，只保留有内容的小节；开头突出主要变化，细项关联 PR，并核对贡献者署名。
- 写明兼容性、迁移及使用限制，不把局部性能测量写成跨平台保证。
- 末尾固定保留 Full Changelog 和 Quick Downloads，下载链接锁定本版标签，不使用 `releases/latest/download`。

正式版末尾模板如下，替换两个标签占位符（含 `v`）。文件名以 [artifactNames](../scripts/release/plan.mjs) 为准；Beta/RC 按该函数使用内测前缀，不照搬正式版文件名。ARM64 SSH 运行包不是 Linux 桌面安装包。

```markdown
**Full Changelog:** https://github.com/Jaxton07/percho/compare/{{previous_tag}}...{{release_tag}}

## Quick Downloads

| Platform | Download |
| --- | --- |
| macOS (Apple Silicon) | [DMG](https://github.com/Jaxton07/percho/releases/download/{{release_tag}}/percho-mac-arm64.dmg) |
| macOS (Intel) | [DMG](https://github.com/Jaxton07/percho/releases/download/{{release_tag}}/percho-mac-x64.dmg) |
| Windows (x64) | [Installer](https://github.com/Jaxton07/percho/releases/download/{{release_tag}}/percho-windows-x64.exe) · [ZIP](https://github.com/Jaxton07/percho/releases/download/{{release_tag}}/percho-windows-x64.zip) |
| Linux (x64) | [AppImage](https://github.com/Jaxton07/percho/releases/download/{{release_tag}}/percho-linux-x86_64.AppImage) |
```

**仅准备到此结束。** 已获正式发布授权时，再创建草稿：

```bash
gh release create "$release_tag" --draft --target "$release_sha" \
  --title "$release_tag" --notes-file "$release_dir/notes.md"
```

Beta/RC 加 `--prerelease --latest=false`。创建后用 `gh release view` 核对标签、草稿状态、完整 SHA 和正文，记录草稿 ID；已知 ID 可直接查询 `repos/Jaxton07/percho/releases/<草稿ID>`。页面可能显示 `untagged`，不据此判断身份。创建成功后暂时查询不到时，最多重查 3 次、间隔 2 秒；仍未确认就保留草稿并停手，不重复创建或推标签。

## 3. 推标签并等待一次发布流程

```bash
git tag -a "$release_tag" "$release_sha" -m "Release ${release_tag}"
git push origin "refs/tags/${release_tag}"
gh run list --workflow release.yml --branch "$release_tag" --limit 1 \
  --json databaseId,headSha,status,url
```

取对应运行的 `databaseId` 为 `release_run_id`，确认 `headSha == release_sha` 后记录；列表尚未出现时短暂等待后重查，不重复推标签或再手动触发一次 Release。

```bash
gh run watch "$release_run_id" --interval 30 --exit-status
```

只保留一个 watch，失败后再查失败日志。[Release workflow](../.github/workflows/release.yml) 自行执行检查、运行包构建与离线验收、桌面打包与隔离启动验收；[发布脚本](../scripts/publish-release.mjs) 复用同提交的草稿、保留正文，校验全部产物并上传完整后才公开。无需本机重复全量测试、打包或手工上传，也不能用 PR 的 Beta 包代替正式包。

已有 main CI 打包可与 Release 并行，无需再等一轮；但 Release 尚不复用其检查结果，不能跳过自己的检查。正式版成为 latest，Beta/RC 不改变正式版 latest。官网由已有的独立 GitHub 自动部署链路更新，正常发版无需额外通知；主仓库的 `website` job 仅为可选的 Cloudflare hook。

## 4. 核对公开结果

workflow 成功后，一次取得公开元数据和小型报告，不重新下载整套安装包：

```bash
gh api "repos/Jaxton07/percho/releases/tags/${release_tag}" > "$release_dir/published.json"
gh release download "$release_tag" --dir "$release_dir/verify" \
  --pattern 'release-*.json' --pattern 'runtime-linux-*.json' \
  --pattern 'SHA256SUMS-*.txt' --pattern 'latest*.yml'
```

逐项核对：

- **发行与说明**：标签、完整源码 SHA、正文正确，`draft=false`；正式版 `prerelease=false` 且 `/releases/latest` 返回本版，Beta/RC 则已标为 prerelease 且未改变正式版 latest。Quick Downloads 的平台和本版资产对应，链接固定到本版。
- **验收与完整性**：三份 `release-*.json` 同版本、同提交，`passed=true`、`mode=release`；两份运行包元数据同版同提交。报告及运行包元数据列出的资产全部上传，GitHub 的 `size`、`digest` 与其字节数、SHA256 一致，摘要文件与报告一致。摘要缺失或冲突时下载相关资产取证，不能算通过。
- **更新源**：正式版的三份 `latest*.yml` 均指向本版；安装包、更新文件、摘要和运行包的预期集合以 [整包校验逻辑](../scripts/release/bundle.mjs) 为准，不写死资产数量。
- **官网**：以实际部署记录或线上显示的版本为准。可选 hook 跳过只表示该通知未执行，不能据此报告“官网未部署／未更新”，也不作为发版故障或待配置项；尚未核实时只写“官网状态未核验”。

公开前已完成整包字节校验，此处只检查报告和公开资产元数据。完成后汇报发行链接、源码、workflow 及未完成项；证据保留在任务目录，不提交本机产物或凭据，本次测试进程应已退出。

## 异常与恢复

| 情况 | 处理 |
| --- | --- |
| 已有标签或草稿 | 核对版本、完整 SHA 和实际阶段；同来源的未公开发行从中断处继续，冲突则停手，不覆盖标签或重建草稿。 |
| 检查、构建或验收失败 | `gh run view "$release_run_id" --log-failed` 定位；相同提交、同一未公开草稿可用 `gh run rerun "$release_run_id" --failed`。修复代码后使用新提交和新版本。 |
| 上传失败 | 保留同提交草稿按发布脚本恢复，不中断在途 publish，不手工公开半套资产或混入其他提交的包。 |
| 已公开且二进制有问题 | 发新版本；不整条重跑以替换安装包或更新文件。 |
| 只修说明 | `gh release edit "$release_tag" --notes-file "$release_dir/notes.md"`；不强制补发 hook 或重跑 website job。 |
| 官网实际未更新 | 在官网的自动部署链路中核对来源、构建和部署记录，再按需重试该部署；不重跑 Release 或替换安装包。 |

## 只要内测包时

仅构建、不公开时，手动触发并保持 `publish=false`：

```bash
gh workflow run release.yml --ref main -f version=0.6.8-beta.1 -f publish=false
```

核对实际源码提交后，从 Actions 下载产物；不创建发行。公开 Beta/RC 走上面的草稿与标签流程；仅本机调试打包见 [本地构建](build-release.md#本地-macos-内测包)。
