---
name: design-handoff
description: 为本项目设计新功能/系统并交接给新会话实施：先调研验证（读代码和 SDK 源码落实事实，不靠猜），产出 spec（.local/agent-work/spec/）+ 实施 plan（.local/agent-work/plan/），创建跨会话沟通频道（.local/agent-work/channel/<主题>/HANDOFF.md），最后更新 INDEX.md。当用户要求「设计 XX」「写 spec 和 plan」「做 handoff / 交接给新会话」「安排新会话实施」时使用。
---

# 设计 + 交接流程（发起会话用）

把「想清楚 → 写下来 → 交给下一个会话」固化为三份产物：**spec**（决策层）、**plan**（文件级执行）、**HANDOFF**（新会话入口）。目录不存在就先建（`mkdir -p`）。

## 第 0 步：调研与验证（最重要，别跳过）

1. 读 `docs/INDEX.md`（项目索引 + 「想改 X 改哪里」速查表）和相关代码。
2. **验证而非猜测**：凡涉及 SDK/API/外部依赖行为的关键论断（函数签名、覆盖语义、默认值、扫描范围），必须读 `node_modules` 里的源码/`.d.ts` 或官方文档落实，并记录出处（文件:行）。
3. 已有的 UI/基础设施要先盘点——很多时候「半边已经完工」（如 renderer 已有对应卡片/解析逻辑），设计只需补缺的那半。
4. 方案对比要有结论：列对比表，说明为什么否掉备选（如「子进程方案在打包态不可用」），不要只列可能性。

## 第 1 步：写 spec — `.local/agent-work/spec/<主题>.md`

决策层文档，回答「为什么这么做」，**不含文件级任务拆分**。结构惯例（参考 `subagent-system.md`、`ui-plugin-system.md`）：

- 背景与现状盘点（已有什么、缺什么、为什么现成方案不可用）
- 目标 / 非目标（非目标写清本期边界，防实施会话膨胀范围）
- 核心决策（对比表 + 一句话机制）
- 架构与代码位置（目录结构、改动点归属哪个包）
- 契约（参数 schema、跨进程类型、details 形状——精确到字段）
- 安全清单
- 里程碑（P1/P2 分期）
- **风险与已验证事实**：第 0 步验证的结论逐条列出处；验证不了的标为「待验证」，交给 plan 阶段 0

## 第 2 步：写 plan — `.local/agent-work/plan/<主题>-plan.md`

执行层文档，给实施会话照着做。结构惯例：

- **阶段 0 冒烟验证**：把 spec 里每个「待验证」变成一个可执行断言脚本（仿 `scripts/smoke-backend.mts`），附通过标准；**卡点处理规则写死：失败回 channel 留言，不许绕过**（后续决策依赖这些事实）
- 后续阶段按文件拆任务：每个任务写清新建/修改哪个文件、做什么、配什么测试
- 验收清单：`npm run typecheck && npm run lint && npm run test` + 逐项手测脚本 + 收尾纪律（关闭测试起的服务/进程、更新 INDEX.md）
- 「明确不做」清单（与 spec 非目标呼应）
- 引用 spec 而非重复其内容

## 第 3 步：建沟通频道 — `.local/agent-work/channel/<主题>/HANDOFF.md`

新会话的唯一入口，自包含、不依赖本次聊天记录。必含：

1. **任务一句话** + 完成定义（= plan 验收清单全过 + 用户 review 通过）
2. **必读文档顺序**：HANDOFF → spec → plan → AGENTS.md + INDEX.md
3. **关键约束**：本项目通用纪律（dev 数据隔离、正式目录零写入、默认路径零行为变化、i18n 双字典、Zustand 稳定引用等，详见 AGENTS.md 踩坑记录）+ 本任务特有的硬约束（如递归防护、目录隔离）
4. **已验证事实表**（事实 | 出处）——实施会话直接采信，禁止重复考证
5. **待决策点**：实施中遇到二选一时自行决策并记录进 IMPL-NOTES
6. **沟通协议**（见下）
7. **自动唤醒提示**：写明实施会话开工时应订阅频道（channel_subscribe 工具，主题 = 目录名）；订阅后你用 channel_post 发消息会自动唤醒对方查收，无需用户人工传话（只写文件不 post 不会通知）
8. **发起方自己也要订阅**：建完频道后立即 `channel_subscribe({ topic })`（主题 = 目录名）——否则对方后续 channel_post 不会唤醒你，通知链路只有单向（常见遗漏，最容易忘的就是这条）

### 沟通协议（写进 HANDOFF，跨会话只认文件不认聊天）

- 实施会话：进度/卡点/决策追加写 `IMPL-NOTES.md`（倒序、每条带日期时间、标注阶段）；完成后写 `DONE.md`（验收清单逐项打勾 + 改动文件清单 + 自测记录）
- review 方：意见追加写 `REVIEW.md`；实施会话开工前先读它（存在的话）
- spec/plan 与代码现状冲突 → 停下来在 channel 留言，**不要自由发挥**
- **channel_post = 通知对方**：文件写入本身不产生通知。写完一组 channel 文件后 `channel_post({ topic, message })` 一条摘要（一次做完一组修改再发）；纯排版/无信息量的变更不要 post——避免无谓唤醒甚至乒乓
- **终态退订**：任务终态（验收通过/废弃）时发起方 `channel_post({ topic, message, closed: true })`；订阅方查收后 `channel_unsubscribe(topic)` 退出频道

## 第 4 步：收尾

**不要把 spec/plan 文件写进 `docs/INDEX.md`**——agent 协作产物随任务生灭、会不定期清理，索引只标 `.local/agent-work/` 目录一行，不标其下的 spec/plan/channel 单个文件。HANDOFF.md 里有完整路径，可发现性靠频道目录本身。

交付后（用户开了实施会话后）：你用 channel_post 发的消息会自动唤醒实施会话查收——需要传达新信息时**写文件 + post 一条摘要即可**（IMPL-NOTES 回应、REVIEW 意见），不必等用户传话；但同样遵守「无信息量不 post」。

回复用户：交付物清单 + 关键决策摘要 + 「新会话从 channel 的 HANDOFF.md 进」。

## 反模式

- spec 里堆实现细节 / plan 里重复设计论证——两层分离
- 未验证的 API 断言直接写进设计当事实
- HANDOFF 引用「见上面的讨论」——新会话没有上面
- 频道高频碎 post / 无信息量 post——每次 post 都唤醒对方，乒乓就是这么烧起来的（写文件本身不通知，post 才通知）
