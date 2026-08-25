---
name: channel-pickup
description: 从本项目的跨会话沟通频道接手已交接的实施任务：读 .local/agent-work/channel/<主题>/ 的 HANDOFF.md 和 spec/plan，按沟通协议推进（IMPL-NOTES 记进度、DONE.md 报完成、REVIEW.md 领意见）。当用户说「接手/实施 channel 里的任务」「按 handoff 开工」「继续 XX 主题的实施」时使用。
---

# 接手频道任务（实施会话用）

你没有上一个会话的记忆，也不需要。**频道目录 + 设计文档是唯一事实来源**，不要找用户复述背景。

## 开工四步（顺序固定）

1. **读频道**：`.local/agent-work/channel/<主题>/HANDOFF.md`（用户没给主题就 `ls .local/agent-work/channel/` 列出让用户选）。若存在 `REVIEW.md` 也一并读——里面的意见是你工作的一部分。
2. **读文档**：按 HANDOFF 指定顺序读 spec（`.local/agent-work/spec/`）→ plan（`.local/agent-work/plan/`，旧任务可能在 `.local/docs/design/` 下——以 HANDOFF 里写的路径为准）→ 项目根 `AGENTS.md` + `.local/docs/INDEX.md`。
3. **采信事实表**：HANDOFF 里的「已验证事实」是上一会话读源码考证过的，直接用，**禁止重复考证**；真要推翻，先回 channel 留言说明证据。
4. **订阅频道**：若 channel_subscribe 工具可用，订阅本频道（主题 = 目录名）。订阅后对方会话写 channel 文件会自动唤醒本会话，无需用户人工传话。

## 唤醒消息入口识别

会话进行中收到的用户消息若**恰好一行**且形如：

```
[channel:<主题>] <文件名> 有更新（HH:MM），请按 .local/agent-work/channel/<主题>/HANDOFF.md 的沟通协议查收。
```

这是 channel-watch 扩展的**自动唤醒**（不是真人输入）。处理方式：

1. 读该文件（IMPL-NOTES.md / DONE.md / REVIEW.md 等），与自己记忆中的最后状态对比。
2. **有实质更新**（新进度、review 意见、待你回应的内容）→ 按沟通协议推进：逐条回应 REVIEW 意见、继续 plan 未完阶段等。
3. **无实质更新**（内容与已读一致、无关紧要的变更）→ 安静跳过，简短告知用户「已查收，无新内容」即可。**不要写任何 channel 文件、不要写 IMPL-NOTES**——你的回写会触发对方会话的唤醒，形成乒乓（防环需要双方都守这条纪律）。

真人输入没有这个模板前缀，按正常对话处理。

## 执行纪律

- 按 plan 阶段推进；**阶段 0 冒烟验证先行**，其断言是后续所有决策的地基。
- plan/spec 与代码现状冲突、或冒烟断言失败 → 停下来写进 `IMPL-NOTES.md` 并告知用户，**不要自由发挥绕过**。
- 遇到 HANDOFF 列的「待决策点」：自行决策，决策与理由记入 `IMPL-NOTES.md`。
- 项目通用纪律全适用（AGENTS.md 踩坑记录先读）：dev 数据隔离（`~/.pi/agent-dev/`、`*-dev` userData，正式目录零写入）、默认路径零行为变化、UI 文案 zh/en 双字典、Zustand selector 稳定引用、preload 保持 CJS 等。
- 测试完毕后关闭过程中起的服务和进程（dev 实例、冒烟脚本、CDP 端口）。

## 沟通协议（只认文件）

- **`IMPL-NOTES.md`**：进度、卡点、决策，追加式、倒序（最新在最上）、每条带日期时间并标注所属阶段。
- **`DONE.md`**（完成时写）：验收清单逐项打勾 + 改动文件清单 + 自测记录（手测每步的实际结果，不是「应该没问题」）。
- **`REVIEW.md`**：review 方的意见入口；每次复工前先读，逐条回应（改代码或在 IMPL-NOTES 说明不改的理由）。
- **写 channel 文件 = 通知对方**：每次写入都会唤醒订阅了本频道的对方会话。合并写入（一次做完一组修改再写，不要逐行保存式高频写）；纯排版/无信息量变更不要写。
- 完成后提醒用户：DONE.md 已就绪，等 review。

## 收尾（DONE.md 之前必做）

1. `npm run typecheck && npm run lint && npm run test` 全绿，输出摘要贴进 DONE.md。
2. 更新 `.local/docs/INDEX.md`：新增/删除/改名的**代码**文件、变化的导出与签名，补进对应清单或速查表。**spec/plan/channel 文档不要加进 INDEX**（索引只标目录不标文件，文档会不定期清理）。
3. 若实施中发现 spec/plan 过时（决策被推翻、边界调整）：在 channel 留言说明，**不要顺手改 spec**——spec 的修改权在发起会话/用户。
