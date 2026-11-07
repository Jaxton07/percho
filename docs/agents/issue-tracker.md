# 议题跟踪器：本地 Markdown

本仓库的议题与规格以 markdown 文件存在 `.scratch/` 下，不使用 GitHub Issues（`gh issue` 不参与任何流程）。`.scratch/` 已加入 `.gitignore`，不入库。

## 约定

- 每个特性一个目录：`.scratch/<feature-slug>/`
- 规格是 `.scratch/<feature-slug>/spec.md`
- 实施议题一个文件一票：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 起编号，不要合成一个总 tickets 文件
- 分类状态写在每个议题文件靠上的 `Status:` 行（角色字符串见 `triage-labels.md`）
- 讨论记录追加在文件底部的 `## Comments` 标题下

## 技能说“发布到议题跟踪器”时

在 `.scratch/<feature-slug>/` 下新建文件，目录不存在就建。

## 技能说“取出对应票据”时

读指定路径的文件。通常用户会直接给出路径或编号。

## Wayfinding 操作（`/wayfinder` 用）

**map** 是一个文件，每张票是它的一个子文件。

- **Map**：`.scratch/<effort>/map.md`，正文放 Notes / 已定决策 / 迷雾。
- **子票**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 起编号，问题写在正文里。`Type:` 行记录票的类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**：靠上的 `Blocked by: NN, NN` 行。它列出的每个文件都变成 `resolved` 后，这张票才解除阻塞。
- **前沿**：扫 `.scratch/<effort>/issues/`，取未被阻塞、未被认领的票，编号最小的优先。
- **认领**：动手前先把 `Status: claimed` 写回文件。
- **解决**：在 `## Answer` 标题下写答案，把 `Status` 置为 `resolved`，再把上下文指引（要点 + 文件链接）追加到 `map.md` 的已定决策里。
