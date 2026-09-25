# LLM 互动叙事架构调研：如何兼顾自由度与长期一致性

日期：2026-09-25

## 结论先行

用户对“把程序做成僵硬状态机”的担心是成立的。**不建议把故事逻辑、NPC 行为和因果关系全面编码成规则。** 但公开的一手资料也不支持“只要换成更强模型，外部状态和运行时迟早都可以删掉”这一判断。

目前较成熟的 LLM 游戏和代理系统普遍采用混合方式：

- 模型负责开放式理解、角色表演、计划、对话和叙事；
- 外部系统负责保存历史、检索相关记忆、接收环境反馈、执行动作和维护少量不可被模型随意改写的事实；
- 需要确定性时，程序约束的是**边界和事实来源**，不是预写故事内容。

对 rpg4pov 最合适的不是“完整语义权威层”，而是一个**薄事实底座 + 模型主导叙事**：保留原始事件账本、按视角检索证据，并让模型从证据解释故事；只对玩家是否作出选择、时间推进、随机结果和已经提交的事实做机械保护。人物动机、关系含义、合理推断和事件走向仍由模型决定。

这不会把游戏做成状态机。它更接近一本不会被偷偷改写的“场记本”。未来模型变强后，可以减少提示、校验和反思调用，但场记本、环境执行和玩家输入所有权仍有价值，而且不依赖特定模型。

## 调研对象与发现

### AI Dungeon / Latitude：自由生成，但通过分层上下文补足记忆

AI Dungeon 是最接近“开放式文字冒险”的成熟产品之一。它没有把叙事变成固定状态图，而是把上下文分层：

- Plot Essentials 始终注入关键设定；
- Story Summary 保存较宽泛的剧情摘要；
- Story Cards 按关键词或相关性动态注入世界知识；
- Memory Bank 用摘要、嵌入和向量检索保存并召回过去事件；
- 最近历史、作者注和玩家最后动作按明确顺序组装进提示。

官方还明确说明：模型会忘记或混淆信息；关键细节应放入 Plot Essentials，长期历史由 Memory System 辅助。系统公开了各类上下文的预算与优先级，而不是把整个故事无差别塞给模型。

来源：[Memory System](https://help.aidungeon.com/faq/the-memory-system)、[What goes into the Context](https://help.aidungeon.com/faq/what-goes-into-the-context-sent-to-the-ai)、[Plot Essentials](https://help.aidungeon.com/faq/plot-essentials)、[Why does the AI forget or mix things up?](https://help.aidungeon.com/faq/why-does-the-ai-forget-or-mix-things-up)

**对本项目的含义：** AI Dungeon 证明开放叙事不需要硬编码剧情，但也说明商用品并不依赖“模型自己全记住”。其弱点是这些内容仍是提示材料：召回能提高一致性，却不能保证模型服从。因此，RAG 适合扩大可见记忆，不适合独自保护玩家决定权或因果事实。

### Stanford Generative Agents / Smallville：自然语言记忆、检索、反思与计划

Generative Agents 在类 Sims 小镇中让 25 个角色自主生活。其核心不是状态机，而是：

1. 保存完整的自然语言经历流；
2. 按相关性、近因和重要性检索记忆；
3. 把经历综合成更高层反思；
4. 用计划维持跨时间行为；
5. 根据新观察调整计划。

论文消融实验显示，观察、计划和反思都对行为可信度有重要贡献。作者也明确预期，即使语言模型继续变强，记忆、计划、反思这些架构基础仍会保留；更强模型提高的是各环节的表达和推理能力。官方代码同样把 scratch 状态、memory stream 和 reflection 分开持久化。

来源：[Generative Agents 论文](https://arxiv.org/abs/2304.03442)、[论文原始仿真代码](https://github.com/joonspk-research/generative_agents)、[StanfordHCI 后续官方代码](https://github.com/StanfordHCI/genagents)、[核心 GenerativeAgent 实现](https://github.com/StanfordHCI/genagents/blob/main/genagents/genagents.py)

**对本项目的含义：** 记忆可以保持为自然语言，不必全部表格化。关键在于保存原始经历，并把“召回什么、何时反思、当前计划是什么”作为独立机制。反思是派生解释，不应覆盖原始事实。

### AI Town：LLM 行为与事务型游戏世界分离

a16z 的开源 AI Town 直接沿用了 Generative Agents 的思路，但加入传统游戏运行时：World、Player、Conversation 和 Agent 从数据库加载、按游戏规则修改，再以 diff 写回。所有玩家和代理输入都经过带验证器的 input handler；例如移动、加入或离开对话会先检查世界不变量。与此同时，代理对话继续由 LLM 结合人格和检索记忆自由生成。对话结束后，系统让模型摘要，再做嵌入并在下次与相关人物对话时召回。

来源：[AI Town 官方仓库](https://github.com/a16z-infra/ai-town)、[架构文档](https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md)

**对本项目的含义：** “程序维护状态”不等于“程序决定故事”。AI Town 的程序确定谁在何处、是否正在对话、输入是否合法；模型确定说什么和如何行动。这是值得采用的边界。

### Convai：高层目标和触发器，而不是固定台词树

Convai 的 Narrative Design 使用图结构，但官方强调它不是僵硬对话树：设计者为一个 Section 写高层 Objective，模型仍动态生成对话；只有需要从应用程序明确控制时，才使用位置、时间或事件 Trigger 推进。其提示还分层加入角色背景、人格、Narrative Design 目标、Knowledge Bank 和 Long-Term Memory，并提供 Mindview 让开发者检查实际注入了哪些上下文。

来源：[Narrative Design](https://docs.convai.com/api-docs/convai-playground/character-customization/narrative-design)、[Memory](https://docs.convai.com/api-docs/convai-playground/character-customization/memory)、[Mindview](https://docs.convai.com/api-docs/convai-playground/character-customization/mindview)、[Character Crafting APIs](https://docs.convai.com/api-docs/api-reference/core-api-reference/character-crafting-apis)

**对本项目的含义：** 如果以后需要剧情结构，应保存“当前目标或压力”，而不是预写下一句或下一事件。程序可发出“夜幕已到”“玩家进入码头”等环境信号；模型决定这些信号怎样转化为戏剧。

### Inworld：模型可替换，运行时编排和可观测性长期存在

Inworld 近年的官方方向从单体 Character Engine 转向可配置的 Runtime graph：在同一管线中编排 LLM、记忆/知识、工具和多模态模块；模型和提示可以通过配置替换、做 A/B 实验，并用 trace、日志和指标追踪非确定性响应。其 Memory Retrieval 节点把近期记录摘要与按嵌入相似度检索的长期记忆结合，还允许 top-K、阈值和来源过滤。其官方总结是，未来不仅需要更强模型，也需要更好的 orchestration（编排）。早期角色工具则区分 Common Knowledge 与 Personal Knowledge，并用 Motivation 引导角色行为。

来源：[Inworld Runtime 架构](https://inworld.ai/blog/new-ai-infrastructure-scaling-games-media-characters)、[Memory Retrieval 节点](https://dev.docs.inworld.ai/unreal-engine/runtime/character-reference/InworldNode_MemoryRetrieval/InworldNode_MemoryRetrieval)、[实时 AI 的工程挑战](https://inworld.ai/blog/three-challenges-of-realtime-conversational-ai)、[角色创建指南](https://inworld.ai/blog/advanced-ai-npc-character-creation-bootcamp-part-1)

**对本项目的含义：** 应把模型调用、记忆、事实来源和校验做成可替换模块，而不是把某个模型的缺陷固化成大量 if/else。可观测性和回放数据不会因为模型升级而过时。

### Voyager：环境反馈与自检形成闭环

Voyager 在 Minecraft 中使用自动课程、可检索的代码技能库和迭代提示。模型生成的程序会在真实环境执行，再把执行错误和环境反馈交回模型，自检后改进。技能库保存可复用、可组合的成功行为，减少灾难性遗忘。

来源：[Voyager 论文](https://arxiv.org/abs/2305.16291)、[官方代码](https://github.com/MineDojo/Voyager)

**对本项目的含义：** 自检最可靠的部分不是“让模型凭感觉审自己”，而是给它外部可验证反馈。格式、文件、骰子和明确事实冲突适合反馈修正；“这段剧情是否好看”不适合用硬门禁。

### SillyTavern：社区工具偏向动态 lore，而非完整世界模拟

SillyTavern 的官方文档把 World Info / Lorebook 定义为动态字典：按关键词、正则、角色、persona 或当前聊天选择性注入背景资料，并提供上下文预算、优先级和递归激活。文档也明确提醒，World Info 只能引导，是否真正使用仍取决于模型。

来源：[SillyTavern World Info 官方文档](https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/worldinfo.md)

**对本项目的含义：** 开源角色扮演社区大量采用“可编辑自然语言 lore + 动态检索”，原因正是它比硬 schema 灵活。但仅靠 lore 无法提供强一致性保证，应与原始事件记录并存。

## 各种路线的实际取舍

| 路线 | 灵活性 | 长期一致性 | 主要问题 | 适合 rpg4pov 吗 |
|---|---:|---:|---|---|
| 纯 LLM + 全历史 | 最高 | 低 | 上下文溢出、注意力稀释、事实漂移 | 不适合作为长期方案 |
| 硬状态机/完整规则库 | 低 | 高 | 作者成本高，开放行动很快碰壁 | 不适合产品目标 |
| RAG / lorebook | 高 | 中低 | 找到证据不代表会服从证据；摘要可能失真 | 应使用，但不能单独承担一致性 |
| 反思/自检 | 高 | 中 | 会把错误总结得更确信；增加延迟 | 只作软改进，不作事实裁判 |
| 多代理规划/审稿 | 中高 | 不确定 | 错误相关、成本和合同倍增 | 当前模型下不应作为主线 |
| 轻量事件账本 + 视角检索 | 高 | 中高 | 需要定义少量事件来源与可见性 | 最适合本项目 |
| 程序化世界模拟 + LLM 表演 | 中 | 高 | 若模拟过细会僵硬 | 只用于确实需要机械确定性的领域 |

## 推荐给 rpg4pov 的边界

### 不要做的“语义权威层”

不要尝试把下列内容做成枚举和规则：

- 每一种人物关系及其数值变化；
- 所有可能的承诺类型；
- 什么推断在什么情境下一定合理；
- NPC 下一步应该做什么；
- 剧情冲突、情绪、主题和象征；
- 所有物体和动作的完整知识图谱。

这会把系统锁进开发者预见到的世界，也最容易被未来更强模型淘汰。

### 建议保留的薄底座

只保存模型无法从截断上下文稳定恢复、且一旦错了会直接破坏玩家信任的证据：

1. **事件账本**：谁在何时何地做了什么、事件来自玩家输入/骰子/模型提议/系统环境中的哪一种。主体仍可是一句自然语言，不要求穷举事件类型。
2. **玩家输入所有权**：玩家是否已经明确选择。程序不判断选择好坏，只阻止模型把未出现的玩家行动登记为已发生。
3. **世界锚点**：当前时间、地点、已绑定随机结果和少数不可逆事件。它们是运行时坐标，不是剧情脚本。
4. **可见性来源**：记录某个角色可检索哪些事件；不是要求程序理解秘密的语义，而是让模型写入或传播信息时附带证据事件 ID。
5. **原始证据不可覆盖**：摘要、人物反思和关系判断都是可重建缓存；它们可以被更强模型重新生成，但不能反向改写事件账本。

### 让模型继续主导的部分

- 从自然语言事件中理解因果；
- 决定 NPC 如何反应、是否相信、怎样推断；
- 提出新事件和新计划；
- 解释关系变化，但不必压成固定数值；
- 生成正文、对话、节奏、悬念与风格；
- 在证据不足时保留模糊和不确定性。

建议的数据流是：

```text
玩家输入 + 当前场景 + 按角色可见性检索的原始事件
                         ↓
                 模型生成叙事与事件提议
                         ↓
       机械检查：是否伪造玩家行动、时间/骰子是否冲突
                         ↓
           提交原始事件；异步更新摘要、反思与索引
```

机械检查只有少数稳定不变量，不需要理解整篇小说。其他语义冲突先通过“把正确证据放进上下文、允许模型修正”解决，而不是持续增加程序规则。

## 未来更强模型会不会替代规则层

会替代一部分，但不是全部。

更强模型很可能逐步替代：

- 手写提示词补丁；
- 复杂的摘要和检索启发式；
- 多阶段审稿代理；
- 为较弱模型准备的格式修复；
- 对人物关系、常识因果的人工规则。

不太会失去价值的部分：

- 已发生事件的持久记录；
- 玩家输入与模型生成内容的来源区分；
- 骰子和外部环境的真实结果；
- 事务、回滚、版本和回放；
- 角色能访问哪些信息的权限边界；
- 模型可替换和质量可观测性。

原因不是未来模型仍然“不聪明”，而是这些属于系统的事实来源和控制权。即使由最强的人类作家主持游戏，也仍需要角色卡、场记、骰子结果和玩家本人决定；这些并不限制创造力，而是让创造力建立在共同现实上。

因此应把底座设计成**模型无关、内容开放、可逐步变薄**：事件正文用自然语言；schema 只描述来源、参与者、时间、可见性和引用关系；所有高层理解均可由未来模型重算。这样模型升级会提升系统，而不会迫使我们推翻它。

## 建议的下一步实验

先不建设完整权威状态，也不马上修改生产架构。做一个最小原型来回答风险最高的问题：

1. 取现有连续验收中的 3 类真实语义失败：时间跳变、NPC 越权知情、把未决定写成已决定。
2. 为每回合保存自然语言事件及 `source`、`time`、`witnesses`、`caused_by` 五个通用字段。
3. 生成时只给每个叙事视角检索到的原始事件与最近正文，不生成大量表格状态。
4. 不增加审稿代理；只机械拒绝与玩家输入、已绑定骰子或单调时间明显冲突的事件提议。
5. 用同一个模型对照跑“现状”和“薄账本”各 10 次，盲评沉浸感、前后连贯、错误率和文本僵硬度。

只有薄账本在不降低叙事自由度的前提下明显减少语义错误，才扩展到正式实现。如果没有改善，就保留研究结论而不增加系统复杂性。

## 证据边界

- 商业产品公开的是功能和开发文档，不是完整后端实现，不能据此断言其内部一致性保证。
- 学术原型主要评估行为可信度或任务完成度，不等同于长篇互动小说质量。
- 公开资料没有证明任何架构能彻底消除幻觉或长期因果错误。
- 因此本文推荐的是与多种一手资料一致、且可由本项目真实失败案例检验的方向，不是已经被行业证明的唯一答案。
