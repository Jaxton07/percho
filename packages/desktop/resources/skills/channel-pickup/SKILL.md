---
name: channel-pickup
description: 从本项目的跨会话沟通频道接手已交接的实施任务：读 .local/agent-work/channel/<主题>/ 的 HANDOFF.md 和 spec/plan，按沟通协议推进（IMPL-NOTES 记进度、DONE.md 报完成、REVIEW.md 领意见）。当用户说「接手/实施 channel 里的任务」「按 handoff 开工」「继续 XX 主题的实施」时使用。
---

# 接手频道任务（实施会话用）

你没有上一个会话的记忆，也不需要。**频道目录 + 设计文档是唯一事实来源**，不要找用户复述背景。

## 开工四步（顺序固定）

1. **读频道**：`.local/agent-work/channel/<主题>/HANDOFF.md`（用户没给主题就 `ls .local/agent-work/channel/` 列出让用户选）。若存在 `REVIEW.md` 也一并读——里面的意见是你工作的一部分。
2. **读文档**：按 HANDOFF 指定顺序读 spec（`.local/agent-work/spec/`）→ plan（`.local/agent-work/plan/`，路径一律以 HANDOFF 里写的为准）→ 项目根 `AGENTS.md`（含其指路的项目索引，如有）。
3. **采信事实表**：HANDOFF 里的「已验证事实」是上一会话读源码考证过的，直接用，**禁止重复考证**；真要推翻，先回 channel 留言说明证据。
4. **订阅频道**：若 channel_subscribe 工具可用，订阅本频道（主题 = 目录名）。订阅后对方会话 channel_post 消息会自动唤醒本会话，无需用户人工传话（只写文件不 post 不会通知你）。

## 唤醒消息入口识别

会话进行中收到的用户消息若**恰好一行**且形如：

```
[channel:<主题>] 有新消息（HH:MM:SS），请读 .local/agent-work/channel/<主题>/MESSAGES.md 查收。
```

这是 channel-watch 扩展的**自动唤醒**（不是真人输入）。处理方式：

1. 读 `MESSAGES.md` 尾部的新条目（每条含时间戳 + 来源会话标记），按其指引读提到的文件（IMPL-NOTES.md / DONE.md / REVIEW.md 等），与自己记忆中的最后状态对比。
2. **有实质更新**（新进度、review 意见、待你回应的内容）→ 按沟通协议推进：逐条回应 REVIEW 意见、继续 plan 未完阶段等。
3. **无实质更新**（内容与已读一致、无关紧要的变更）→ 安静跳过，简短告知用户「已查收，无新内容」即可。**不要回 post**——你的回 post 会触发对方会话的唤醒，形成乒乓（防环需要双方都守这条纪律）。
4. 条目带 `[CLOSED]` 标记 → 任务/频道终态：查收后 `channel_unsubscribe(<主题>)` 退订本频道。

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
- **channel_post = 通知对方**：写 channel 文件本身不通知任何人。写完一组文件后 `channel_post({ topic, message })` 发一条摘要唤醒订阅者；合并修改一次发一条，不要逐行保存式高频 post；纯排版/无信息量变更不要 post。
- 完成后提醒用户：DONE.md 已就绪 + 已 post，等 review。

## 收尾（DONE.md 之前必做）

1. `npm run typecheck && npm run lint && npm run test` 全绿，输出摘要贴进 DONE.md。
2. **若项目有索引/导航文档**（`AGENTS.md` 通常会指路）：新增/删除/改名的**代码**文件、变化的导出与签名，补进对应清单或速查表；**spec/plan/channel 文档不要加进去**（索引只标目录不标文件，文档会不定期清理）。项目没有索引就跳过本步，**不要新建**。
3. 若实施中发现 spec/plan 过时（决策被推翻、边界调整）：在 channel 留言（写 IMPL-NOTES + post 一条）说明，**不要顺手改 spec**——spec 的修改权在发起会话/用户。
4. **任务终态**：收到对方 `[CLOSED]` 消息 → 查收后退订；本方任务被验收/废弃 → `channel_post({ closed: true })` 告知各方后 `channel_unsubscribe`。
