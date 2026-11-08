# 领域文档

工程类技能在探索代码库时如何消费本仓库的领域文档。

本仓库是**单上下文**布局：全仓库共用一套术语，不按 `packages/*` 拆分词汇表。

## 探索之前先读这些

- 根目录的 **`GLOSSARY.md`**
- **`docs/adr/`**：读即将动手的那块区域相关的 ADR

文件不存在就**静默继续**。不要提示缺失，也不要主动建议先建。`domain-modeling` 技能（经由 `grill-with-docs` 和 `improve-codebase-architecture` 触达）会在术语或决策真正落定时才按需创建。

## 目录结构

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── 0001-event-sourced-orders.md
│   │   └── 0002-postgres-for-write-model.md
│   └── agents/            ← 本目录：技能的配置约定
└── packages/
    ├── shared/
    ├── backend/
    └── desktop/
```

## 使用词表里的说法

输出里出现领域概念（议题标题、重构提案、假设、测试名）时，用 `GLOSSARY.md` 定义的那个词。不要漂移到词表显式回避的同义词。

需要的概念词表里还没有，这本身是个信号：要么你在发明项目不用的说法（重新想想），要么确实缺一个词（记下来给 `domain-modeling`）。

## 标出 ADR 冲突

输出与已有 ADR 相矛盾时明确说出来，不要悄悄覆盖：

> _与 ADR-0007（事件溯源订单）冲突，但值得重开，因为……_
