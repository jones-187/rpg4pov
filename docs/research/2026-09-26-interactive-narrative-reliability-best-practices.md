# LLM 互动叙事长期连续性与语义错误：社区与行业最佳实践

日期：2026-09-26

## 结论先行

公开的一手资料没有显示，成熟的互动叙事产品会依赖一个“审查模型”来保证事实正确。更常见、也更稳妥的做法是：

1. 保留完整或可回放的原始历史，把它作为最终证据；
2. 把摘要、Lorebook、Memory 和 Reflection 当成可丢弃、可重建的上下文辅助层；
3. 只检索当前相关的资料，不把全部记忆长期塞进提示；
4. 给玩家提供 Retry、Edit、Undo、分支或人工确认，让错误可以低成本恢复；
5. 程序只保护来源、提交、回滚、随机结果和玩家控制权，不编写剧情；
6. 只有在评价标准明确、且 A/B 实测确实改善质量时，才加入 evaluator-optimizer（生成—审查—修正）流程。

这与 rpg4pov 的实测结果一致：Kimi K3 审查只发现了少量错误，却放过了大量同类硬错误。因此，下一步最好的做法不是继续增加审查模型，也不是继续逐个更换生成模型，而是把 **Story Workspace / Turn History 的权威证据** 与 **模型生成的叙事记忆** 明确分层。

推荐采用“**双层记忆 + 可恢复交互**”：

- **权威锚点层**只保存玩家明确输入、系统设定、绑定随机结果、已提交历史及它们的来源；
- **叙事记忆层**保存模型摘要、人物理解和 Continuity Card，但明确标记为派生资料，必须能追溯到原始历史，也不能反向覆盖权威锚点；
- 生成时同时给模型“简短记忆”和相关原文证据，并声明原文证据优先；
- 当前回合仍允许模型自由创造新细节。程序不判断文学内容是否合理；出现问题时由玩家 Retry、Edit 或修正记忆，而不是让多个模型无限互审。

这条路线不能保证模型永不胡编。它能解决更重要的问题：**一次胡编不会被自动升级成永久事实，并在后续几十回合持续传播。**

## 一手资料显示的共同模式

### 1. AI Dungeon：自动记忆不是最终权威，玩家保留编辑和重试能力

AI Dungeon 将上下文分成多层：Plot Essentials 始终注入；Story Cards 按触发词使用；Story Summary 保存剧情概览；Memory Bank 检索相关旧记忆；最近历史和玩家最后动作仍单独进入上下文。自动 Memory 是模型对六个旧动作及响应生成的摘要，并不是原始历史本身。最近六个动作还保留 Undo / Edit 空间，不会立刻影响已生成的 Memory。

官方同时明确说明，AI 仍可能忘记或混淆信息，Memory System 不能保证百分之百正确。推荐的恢复方式包括 Retry、修改 Plot Essentials，或直接用 Edit 修正内容。产品把玩家视为故事的主角和导演，而不是承诺由另一个模型自动消除全部错误。

来源：

- [AI Dungeon Memory System](https://help.aidungeon.com/faq/the-memory-system)
- [AI Dungeon Context 组成和预算](https://help.aidungeon.com/faq/what-goes-into-the-context-sent-to-the-ai)
- [AI Dungeon Plot Essentials](https://help.aidungeon.com/faq/plot-essentials)
- [AI Dungeon：AI 为什么会忘记或混淆](https://help.aidungeon.com/faq/why-does-the-ai-forget-or-mix-things-up)
- [AI Dungeon 基础操作：Undo、Redo、Retry、Edit](https://help.aidungeon.com/faq/the-basics)

**对 rpg4pov 的含义：** 自动摘要适合提高召回率，不适合作为不可质疑的 canon。恢复按钮不是失败的临时补丁，而是生成式叙事产品的正式可靠性机制。

### 2. SillyTavern 与 NovelAI：Lorebook 是可编辑提示资料，不是事实裁判

SillyTavern 把 World Info / Lorebook 定义为动态字典。它根据关键词、角色、Persona 或当前聊天注入相关背景，并提供预算、优先级、插入位置和作用域。官方文档明确提醒：World Info 只能引导模型，不能保证模型在输出中正确使用它。

NovelAI 的 Lorebook 也是独立、可编辑的资料库。条目由关键词激活，用户可以启用、停用、编辑、导入和导出。Memory 与 Author's Note 也是用户可控制的提示区域。脚本若要修改 Lorebook，必须获得 `lorebookEdit` 权限。这些设计把“谁能改记忆”和“何时把记忆注入模型”作为显式边界。

来源：

- [SillyTavern World Info 官方文档](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [SillyTavern World Info 官方源码文档](https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/worldinfo.md)
- [NovelAI Lorebook](https://docs.novelai.net/en/text/lorebook/)
- [NovelAI Story Settings：Memory 与 Author's Note](https://docs.novelai.net/en/text/editor/storysettings/)
- [NovelAI Lorebook API 权限](https://docs.novelai.net/en/scripting/lorebook-api/)

**对 rpg4pov 的含义：** Public Continuity Card 应更像“可见、可编辑、可关闭的 Lorebook”，而不是后台自动维护的第二套真相。它应有来源和变更记录，用户应能修正或锁定重要条目。

### 3. Generative Agents：保存经历流，反思只是派生解释

Generative Agents 保存完整的自然语言经历流，再按近因、重要性和相关性检索。Reflection 会从多条经历综合出更高层解释，Plan 再使用这些信息指导行为。论文的消融实验表明，记忆、反思和计划共同提高了行为可信度。

但论文也报告了典型错误：未检索到关键记忆、对记忆作虚构性润色，以及继承底层模型不合适的表达习惯。也就是说，Reflection 能提高整体表现，却不能成为可靠的事实验证器。

来源：

- [Generative Agents 原始论文](https://arxiv.org/abs/2304.03442)
- [Generative Agents 作者官方代码](https://github.com/joonspk-research/generative_agents)

**对 rpg4pov 的含义：** 原始经历和派生理解必须分开。人物反思、关系含义和剧情摘要可以重算；它们不能删除或改写原始事件。

### 4. MemGPT / Letta：分层记忆，但完整消息仍被保存

MemGPT 用类似操作系统虚拟内存的方式管理不同层级的记忆，让模型在有限上下文中调入和移出资料。其后续官方实现 Letta 明确区分 system prompt、memory blocks、消息和工具。重要核心记忆会固定在上下文中；较旧消息即使被压缩或移出窗口，仍保存在数据库中，可由开发者 API 或检索工具重新取得。Memory block 可由模型工具修改，也可由开发者直接修改。

来源：

- [MemGPT 原始论文](https://arxiv.org/abs/2310.08560)
- [Letta Stateful Agents 官方文档](https://docs.letta.com/v1-sdk/concepts/stateful-agents)

**对 rpg4pov 的含义：** 压缩和检索不应该销毁证据。Turn History 应永久保留；Continuity Card 只是当前工作记忆，可以重建、替换或回滚。

### 5. LangGraph：短期状态、长期存储和人工中断是不同机制

LangGraph 把短期记忆放在每个 thread 的持久状态中，把跨会话资料放在独立 store 中。它还提供 interrupt：在关键动作前暂停，允许人批准、编辑或拒绝，然后从持久 checkpoint 恢复执行。

这一设计没有假定 LLM 自己能可靠批准自己的所有动作。它把“持久化”“长期资料”和“关键操作的人类控制”做成不同边界。

来源：

- [LangGraph Memory 官方文档](https://docs.langchain.com/oss/python/langgraph/add-memory)
- [LangGraph Interrupts / Human-in-the-loop](https://docs.langchain.com/oss/python/langgraph/interrupts)

**对 rpg4pov 的含义：** 不需要让玩家审核每一回合，但高影响的记忆升级可以有轻量确认。例如“玩家已经答应婚约”“秘密已公开”“随机判定永久改变角色状态”这类条目，可以显示变更提示并允许撤销。

### 6. Inworld：近期记忆与长期检索分开，并保留来源过滤

Inworld 的 Memory Retrieval 节点会始终包含一定数量的近期 flash memory，再按语义相似度召回长期记忆。检索参数包括 top-K、相似度阈值和来源过滤。重点是选择相关资料并控制来源，而不是让模型把所有旧内容重新总结成一份无来源文本。

来源：

- [Inworld Memory Retrieval 官方文档](https://dev.docs.inworld.ai/unreal-engine/runtime/character-reference/InworldNode_MemoryRetrieval/InworldNode_MemoryRetrieval)

**对 rpg4pov 的含义：** 检索结果应携带 `source turn / source event`，并把相关原文片段与摘要一起交给模型。只给摘要会让错误很难被模型或玩家追查。

### 7. Anthropic：审查循环只适用于清晰、可测量的评价标准

Anthropic 的官方工程指南建议从最简单的方案开始，只在简单方案不足时增加 agentic complexity。Evaluator-optimizer 适合两种条件同时成立的任务：人类能清楚描述评价标准，且 evaluator 的反馈能带来可测量改善。指南也强调，复杂 agent 系统会用延迟和成本换取表现，不能默认它一定更可靠。

来源：

- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)

**对 rpg4pov 的含义：** JSON、路径、随机确认、来源 ID 是否存在，都有清晰判据，适合自动校验和有限修正。“这段自然语言是否暗中增加了文件栏位”目前没有可靠自动判据；本项目 A/B 又证明 Kimi 审查不能稳定识别，因此不应继续叠加审查模型。

## 社区做法回答了什么

### 如何区分权威历史与模型记忆

共同做法是保留两类资料：

| 层 | 内容 | 是否权威 | 是否可重建 |
|---|---|---:|---:|
| 原始历史 / 消息 / 世界状态 | 玩家输入、已发生事件、环境结果、已提交文本 | 是 | 否，应保留或可回放 |
| Memory / Summary / Lorebook / Reflection | 摘要、召回提示、人物理解、世界资料 | 否，除非由用户明确确认 | 是 |

并非所有产品都使用“canon”一词，也没有统一数据结构；但它们普遍不会因为生成了摘要，就删除原始消息或把摘要变成不可编辑的唯一真相。

### 如何处理模型捏造和错误记忆

公开方案主要依赖以下组合，而不是单一技术：

- 保留原始历史，允许重新检索；
- 让记忆条目可编辑、可关闭、可回滚；
- 对当前相关内容按需注入，减少无关上下文干扰；
- 提供 Retry、Edit、Undo、分支或人工批准；
- 对真正可验证的边界使用程序校验；
- 接受模型仍会犯错，不对用户承诺百分之百语义正确。

### 是否依赖审查模型

没有找到上述主流互动叙事产品把“第二个 LLM 对每回合作语义审核”公开为事实可靠性的核心机制。研究系统会使用 Reflection 或自评，但它们提高的是平均行为质量，不是事实保证。Anthropic 也只在评价标准清晰且收益可测量时推荐 evaluator-optimizer。

因此，本项目已经完成的异构审查 A/B 很有价值：它不是“还需要更多提示”，而是说明当前语义问题不满足可靠 evaluator 的前提。继续增加审查员、投票或重试没有一手证据支持。

### 怎样保留灵活性

成熟方案约束的是上下文和事实来源，不是剧情内容：

- Lorebook 用自然语言，不要求完整知识图谱；
- 只在相关时注入，不固定剧情分支；
- 模型仍决定人物语言、动机、反应、节奏和新事件；
- 程序只管理存储、检索、权限、随机结果、提交与恢复；
- 用户能编辑记忆和故事，因此不会被错误状态永久锁死。

## 对 rpg4pov 最合适的下一架构

### A. 保留当前可靠部分

继续保留：

- Story Workspace 作为唯一事实来源；
- Turn History 由 Trusted History Committer 提交；
- 完整候选校验、快照、原子提交和失败回滚；
- Binding Random Outcome、Protagonist Control Boundary 等可机械保护的边界；
- 一次格式修正；
- 可注入 `semanticReviewer` seam 仅供实验，默认关闭。

不要继续增加第二审查员、投票、无限重试或模型专用的语义补丁。

### B. 把 Public Continuity Card 拆成两种资料

#### 1. Canon Anchors（权威锚点）

只允许以下来源自动进入：

- 用户明确输入；
- Story Initialization 中已确认的设定；
- Binding Random Outcome；
- 系统提交的时间、地点和外部结果；
- 已提交 Turn History 的原文引用。

每条只需要少量通用字段：`id`、自然语言 `text`、`sourceType`、`sourceRef`、`visibility`、`status`。`sourceRef` 必须指向真实存在的 turn、初始化资料或随机结果。程序只验证引用和权限，不判断文学含义。

#### 2. Narrative Memory（叙事记忆）

模型可自由维护：

- 剧情摘要；
- 人物对事件的理解；
- 可能的因果；
- 未决问题；
- 关系和情绪反思。

这些内容必须标记为 `derived` 或 `uncertain`，并附来源引用。它可以帮助召回，但不能覆盖 Canon Anchors，也不能作为“玩家已经决定”“某文件明确写着”“某角色亲眼看见”的唯一证据。

### C. 检索时同时提供记忆和原文证据

建议的生成上下文：

```text
当前场景 + 玩家本回合输入
        ↓
相关 Canon Anchors（高优先级）
        ↓
相关 Narrative Memory（明确标记为摘要/推测）
        ↓
对应的少量 Turn History 原文片段
        ↓
模型自由生成完整回合候选
```

提示只规定一条稳定原则：原始证据高于摘要；证据不足时可以让角色猜测、说谎或不确定，但不能写成外部文件或玩家已经明确确认的事实。

### D. 让错误可恢复，而不是假装错误已被消灭

推荐增加最小的玩家控制：

1. **Retry 当前回合**：废弃当前候选并重新生成；不污染 Canon Anchors。
2. **编辑/纠正记忆**：玩家能看到本回合新增或变更的锚点与叙事记忆。
3. **撤销或锁定条目**：锁定后的玩家确认内容不能被模型改写。
4. **高影响变更提示**：只对玩家重大决定、秘密公开、永久状态、明确文件条款等少量类别提示；不要求每回合人工审核。

这不是把责任全部交给玩家。系统仍负责提供清晰、低成本的恢复路径，并保证修正之后不会被旧错误再次覆盖。

### E. 当前回合的语义错误如何处理

双层记忆主要防止错误长期扩散，不能证明当前正文没有幻觉。因此产品应明确采用以下失败策略：

- 一般场景细节允许模型创造；它们是开放叙事的一部分；
- 模型对既有证据的陈述若出错，玩家可 Retry 或 Edit；
- 若系统检测到确定性冲突，例如伪造玩家选择、违背随机结果、引用不存在的来源，则回合失败回滚；
- 不用不可靠的 LLM reviewer 把“通过”包装成事实保证。

这里的关键区别是：**新创作**可以自由，**伪称旧证据**必须有来源。程序不决定故事应该怎样发展，只保护共同历史不被悄悄改写。

## 推荐实施顺序

### 第一阶段：先做最小的“来源分层”实验

不改生成模型，不增加模型调用。选取现有三类硬错误案例：虚构文件条款、虚构目击、污染故事时间。

实现和测试：

1. 将 Continuity Card 条目区分为 `anchor` 与 `derived`；
2. 为两类条目保存 `sourceRef`；
3. `anchor` 缺少有效来源时拒绝进入长期记忆；
4. `derived` 可以保存，但在提示中明确为可疑摘要；
5. 检索时为每条派生记忆附一小段原始历史证据；
6. 同一冻结案例每臂至少重复三次，比较现状与来源分层方案。

门槛：长期记忆不得把无来源内容升级成权威事实；叙事质量不得明显下降；调用次数不增加。

### 第二阶段：只在第一阶段通过后增加恢复界面

加入本回合 Retry，以及 Continuity Card 的查看、修正、锁定和撤销。先做最小界面，不建设完整编辑器或知识图谱。

### 第三阶段：做长局验证

用 10～20 回合真实故事验证：

- 错误记忆是否仍会跨回合扩散；
- 原文证据是否能帮助模型恢复正确上下文；
- 玩家纠正一次后是否永久生效；
- 上下文长度和延迟是否可接受；
- 叙事是否仍然自由、自然。

通过后，才考虑让 Public Continuity Card 默认开启。

## 明确不推荐的下一步

- 不继续按价格或模型名称逐个碰运气；更强模型可作为未来替换件，但不是当前架构的可靠性证明。
- 不增加多个审查模型、投票或无限修正；现有 A/B 已显示审查判据不可靠。
- 不把所有人物关系、行为、因果和剧情走向做成程序状态机。
- 不让模型摘要覆盖 Turn History。
- 不把“格式通过”或“reviewer 通过”显示成“事实已验证”。
- 不要求玩家每回合审核完整结构化状态；只在少量高影响变更上提供可见控制。

## 能解决与不能解决的问题

| 问题 | 这套方案的效果 |
|---|---|
| 格式和字段非法 | 现有有限格式修正继续处理 |
| 一次错误污染几十个后续回合 | 明显降低；错误派生记忆不能覆盖权威锚点 |
| 无法追查某条记忆来自哪里 | 解决；每条都有 `sourceRef` |
| 玩家纠正后模型再次改回错误内容 | 通过锁定锚点和权威优先级降低 |
| 模型当前回合偶尔胡编 | 不能根除；依赖 Retry、Edit 和确定性冲突回滚 |
| 文学表达和开放行动被程序限制 | 较少影响；剧情内容仍由模型生成 |
| 模型未来升级后架构过时 | 风险较低；原始历史、来源、回滚和检索仍有价值 |

## 最终建议

下一项正式工作应是：**把 Public Continuity Card 从“自动权威记忆”改为“有来源的双层记忆”，并用现有冻结案例做三轮 A/B。**

在实验通过前：

- DeepSeek v4.1 Flash 继续作为当前基线，不表示它已经合格；
- Public Continuity Card 继续默认关闭；
- Kimi K3 语义审查继续默认关闭；
- 不再增加新的审查链；
- 保留 Retry / Edit / 可纠正记忆作为产品级可靠性方向。

这条路线接受一个现实：现阶段没有模型或审查链能保证每个自然语言事实都正确。最好的工程做法不是把模型绑死，也不是假装它不会犯错，而是让权威证据不会丢失、派生记忆不会冒充事实、错误不会无限扩散、玩家随时能够恢复故事。

## 证据边界

- 商业产品公开的是功能和部分技术说明，不是完整后端实现；本文没有推断其未公开的内部校验逻辑。
- 学术论文主要评估行为可信度、记忆能力或长上下文任务，不等同于长篇第一人称互动叙事质量。
- 没有一手资料证明任何方案可以彻底消除 LLM 幻觉。
- “双层记忆 + 可恢复交互”是基于这些共同模式和 rpg4pov 实测失败作出的工程推论，仍必须由本项目 A/B 验证。
