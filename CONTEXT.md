# 项目术语表 (Glossary)

本文件是领域术语表，记录项目中关键概念的规范定义。不含实现细节。

## 故事相关

### Story Workspace
每个 storyId 对应的独立工作空间，是故事状态的**唯一事实来源**。采用 Markdown-first 布局，包含故事元数据、世界设定、主角信息、NPC 角色卡、日志和回合输入输出。

### Story Turn（故事回合）
用户输入主角行动后，系统执行的一次完整处理周期。一个回合从用户输入开始，到返回主角可见输出结束。同一 storyId 的回合串行执行。

### Player-visible Output（主角可见输出）
回合完成后，用户能通过 Web 界面看到的内容。**只来自 `turn/output.md`**，不包含 agent stdout、内部日志、God State、NPC 私有记忆或随机判定日志。

## 叙事与主角相关

### Meaningful Change（有效变化）
一个正常回合结束后，玩家能够感知到的叙事变化。可以是新信息、关系变化、角色决定、目标进展或受阻、风险变化、时间/地点/场景变化、新性格侧面、理解变化、新目标/放弃旧目标或冲突阶段变化。
_Avoid_: 复述玩家输入、平级环境细化、无信息量身体/天气描写、同一情绪原地延长、只写得更长或更华丽

### Character Intent（角色意图）
重要角色在当前回合中的最小动态状态，包括 `currentEmotion`、`immediateGoal`、`hiddenIntent` 和 `voice`。角色台词与行动应服务于自己的即时目标，而不只是回答玩家、提供说明或等待玩家推进。
_Avoid_: NPC 被动应答器、万能解释员、围绕玩家服务的无目标角色

### Performance（表演）
把 Meaningful Change 和 Character Intent 渲染成玩家可见内容的呈现层。优先通过潜台词、反问、回避、打断、停顿、动作与台词张力、角色语言习惯、回调和选择表现情绪，而不是直接解释 NPC 的全部心理。
_Avoid_: 通用 AI 台词、抽象关系总结、模板化眼神/呼吸/手指描写、隐藏意图直出

### Narrative Turn Contract（叙事回合契约）
Story Turn 的叙事逻辑顺序：理解玩家输入和故事状态 → 读取主角模型 → 确定至少一个 Meaningful Change → 确定相关角色 Character Intent → 决定 NPC 主动行为 → 判断主角可自动演出与必须交还玩家的决定 → 渲染第一人称视觉小说式输出 → 判断 Continuous Performance 或 Decision Point → 更新必要状态。
_Avoid_: 先写正文再事后找意义、每回合只扩写氛围、引入完整多 Agent 架构

### Adaptive Authored Protagonist（自适应预设主角）
主角拥有预设人格、第一人称叙述声音和常规行为方式；系统可以自动生成符合设定的心理活动、低风险台词和自然反应；玩家掌握关键选择、重大关系方向和不可逆决定；系统根据玩家长期行为和显式反馈逐渐微调主角，但不能根据单次行为过拟合。
_Avoid_: 空白摄像头主角、完全独立于玩家的固定主角

### Protagonist Core（基础男主骨架）
创建故事时生成或确定、变化缓慢的主角基础模型。至少包含 `narrativeVoice`、`temperament`、`emotionalExpression`、`conflictStyle`、`relationshipStyle`、`humorStyle`、`initiative`、`moralBoundaries`、`speechPatterns` 和 `avoidExpressions`。
_Avoid_: 只有姓名/身份、没有声音和行为倾向的玩家占位符

### Confirmed Adjustments（玩家确认修正）
来自创建故事时明确要求、玩家直接说明的长期偏好、纠正错误表现或“以后不要这样写”反馈的主角模型修正。优先级高于 Protagonist Core 和 Inferred Tendencies。
_Avoid_: 把显式反馈当作低置信推测、让系统推测覆盖玩家纠正

### Inferred Tendencies（推测倾向）
根据多次玩家行为逐渐形成的主角倾向，必须包含 `tendency`、`confidence`、`evidence` 或 `evidenceCount`，必要时包含 `caution`。主要影响内心独白、低风险台词、冲突习惯、主动程度和常规互动方式，不得直接决定爱恨、原谅、承诺、关系定义、道德底线或重大选择。
_Avoid_: 单次行为定型、把临时反应升级为稳定人格、偷偷把推测当事实

### Player Agency（玩家主导权）
玩家控制本回合明确输入、关键方向、重大关系选择、承诺/拒绝/信任/原谅等心理结论和不可逆决定。系统可以补全玩家已选择行为“如何发生”，但不能擅自决定玩家尚未选择的关键方向。
_Avoid_: 替玩家告白、替玩家原谅、替玩家背叛、替玩家关闭重要选择

### Continuous Performance（连续演出）
当事件尚未到达真正需要玩家决定的位置时，系统继续推进当前人物和事件。可以继续 NPC 对话、主角心理活动、低风险自然反应和事件发展；玩家仍可自由输入打断。“继续”是系统级控制，不是主角台词或故事内行动。
_Avoid_: 每小段都强制输入、无限无意义扩写、把继续当角色行动

### Decision Point（决策点）
关键控制权应交还玩家的位置。通常涉及 NPC 明确要求回答、关系重要变化、风险/障碍处理、是否公开信息、冲突升级/缓和/结束、承诺/拒绝/信任/原谅/关系方向、多个合理但系统不应替玩家判断的方向，或下一步会关闭重要选择/造成不可逆后果。
_Avoid_: 停在纯环境描写、模糊感慨、无压力沉思、机械要求输入“继续”

### Suggestion Gate（建议选项门槛）
建议是 Decision Point 的交互辅助，不是剧情推进机制。建议数量允许为 0 到 4 个，不固定凑数；所有建议应回应同一个当前戏剧问题，点击建议只填入输入框，不自动提交，玩家始终可以自由输入。
_Avoid_: 每回合强制四选项、横向开启无关支线、用”继续观察/继续思考”掩盖剧情没有推进

### Protagonist Control Boundary（主角控制权边界）
系统可自动处理与不得自行增加的行为分界。系统可补全玩家已明确行动的执行细节、不改变立场的自然接话、日常寒暄、符合人格的小动作、当下感知和心理活动、不关闭重要选择的低风险主动行为、符合稳定人格的自然反应和不构成重大承诺的过渡性台词。系统不得自行增加玩家未表达的新目标、重大承诺、关键关系决定、道德越界行为、与玩家当前输入冲突的台词、会关闭重要选择的决定、爱恨原谅决裂等关系定案和明显改变路线的不可逆行动。
_Avoid_: 系统可自动做一切、系统不可自动做任何事、边界模糊导致替玩家决定关键方向

### Explicit Feedback（显式反馈）
玩家对主角表现的纠正，分两类：**本次纠正**只修正当前生成，不改变长期主角模型；**长期偏好**写入 Confirmed Adjustments，影响后续所有生成。显式反馈优先级高于系统根据行为作出的推测。
_Avoid_: 把所有纠正当长期偏好、偷偷把推测升级为确定人格、不区分一次性和永久性修正

### Inner Monologue Guideline（内心独白准则）
第一人称心理描写的规范。系统应积极生成注意力变化、当下联想、记忆触发、瞬间情绪、内心吐槽、疑问和猜测、犹豫、尚未完成的冲动、符合主角基础人格的明确情绪表达、对角色行为和异常细节的即时理解。心理描写应有明确的主角声音，不能长期停留在”说不上来的感觉””心里有些复杂””一种莫名的情绪”等极度模糊和中性的表达。
_Avoid_: 长期无心理描写、替玩家完成关键心理结论、用模糊中性表达回避声音

## 随机相关

### Random Tool（随机工具）
由系统提供的真实随机判定机制，用候选项与权重/概率选出一个结果，不能由模型自行假装随机。
_Avoid_: 模型随机、叙事随机、假随机

### Roll Choice（候选随机）
Random Tool 的最小操作：在一组候选项中按权重/概率选择一个结果。
_Avoid_: dice roll、自由发挥

### Random Judgment（随机判定）
对有不确定性、风险或抵抗的故事结果进行的系统判定，由上下文约束候选项并通过 Random Tool 产生结果。
_Avoid_: 任意剧情转折、模型自选结果

### Binding Random Outcome（绑定随机结果）
Random Judgment 产出的最终结果，Agent Runner 必须把它作为故事输出与状态推进的约束。
_Avoid_: 建议结果、参考结果

### Random Log（随机判定日志）
记录 Random Judgment 的候选项、权重/概率与选中结果的内部日志，只用于审计，不对用户可见。
_Avoid_: 玩家随机记录、调试面板、可见骰点

### Random Tool CLI Wrapper（随机工具 CLI 包装器）
Issue 6 引入。把 Random Tool 库函数（`rollChoice`）包装成 CLI 子进程可调用的接口，供 Claude Code Runner 经 Bash 工具调用。输入为 stdin JSON，输出为 stdout JSON（`RollChoiceResult`）。复用 `random-tool.ts` 领域逻辑，不重复实现。是 Agent Runner（子进程）与 Random Tool（库函数）之间的桥接层。
_Avoid_: MCP server、随机工具重实现、agent 内置随机

## Agent 相关

### Agent Runtime Adapter（Agent 运行时适配器）
Web/API 层与具体 agent 实现之间的**稳定边界**。在代码中体现为 `AgentRunner` 接口。Web 层只依赖此接口，不感知具体 runner（Fake Agent、Claude Code CLI 等）。

### Agent Runner（Agent 运行器）
`AgentRunner` 接口的具体实现。在 Story Workspace 目录内执行一个回合：读取当前状态、写入主角可见输出、写入运行成功标记。每回合冷启动，不依赖长期会话记忆。

### Turn Orchestrator（回合编排器）
回合生命周期的编排者。负责：清理上回合标记 → 写入主角输入 → 调用 Agent Runner → 检查磁盘权威状态 → 读取主角可见输出。持有 AgentRunner 实例，对回合内的所有失败负责。

### Fake Agent Runner（假 Agent 运行器）
Issue 3 引入的验证用 Agent Runner 实现。不接入真实大模型，读取主角输入后生成固定格式输出，用于跑通架构闭环。是临时验证组件，非永久产品运行时。

### Claude Code Runner（Claude Code 运行器）
Issue 6 引入的首个真实 Agent Runner 实现。通过冷启动 `claude` CLI 子进程在 Story Workspace 内执行一个回合，让 CLI 自主读 workspace 文件、按 prompt 指令写 `turn/output.md` 与 `turn/done.json`。是 MVP 验证用运行时，非永久产品运行时——arch-prd 明确 Claude Code Runner 是 validation runtime，未来可替换为 Custom Story Agent Runner、SDK Runner 或 HTTP Agent Service Runner。
_Avoid_: 永久 agent、产品运行时、会话型 agent

### Runner 切换（Runner Selection）
Web/API 层通过环境变量 `AGENT_RUNNER` 选择具体 Agent Runner 实现（`fake` / `claude`），默认 `fake`。route.ts 模块级单例根据该变量实例化 runner。docker-compose 默认不启用 `claude`，避免无 `ANTHROPIC_API_KEY` 时普通开发跑不起来；启用 `claude` 经 env 覆盖或额外 compose 文件完成。vitest 契约测试始终用 `fake`，不依赖真实 CLI/凭证/网络。
_Avoid_: 配置文件、运行时热切换、默认强制真实 agent

## 回合状态相关

### Done Marker（运行成功标记）
`turn/done.json` 文件，由 Agent Runner 在回合成功完成后写入。Turn Orchestrator 以此文件的**磁盘存在性和状态**为权威依据判断回合是否成功，不依赖 runner 的返回值。回合开始前由 Orchestrator 清理。

### Turn Snapshot（回合快照）
回合开始前由 Orchestrator 创建的整个 Story Workspace 目录副本，用于失败回滚。**不是 Story Workspace 的一部分，不是故事状态**——是瞬态恢复机制，存活期不超过一次回合。存放在 Story Workspace 目录之外（`{WORKSPACE_ROOT}/.snapshots/{storyId}/`），每故事单份、回合前覆盖。
_Avoid_: 版本历史、备份、checkpoint

### Turn History（回合历史）
已提交的玩家可见故事时间线，存储在 `turns/history.jsonl`。条目类型包括 opening（开场内容，无玩家输入）和 turn（正常回合，有玩家输入）。由受信任的系统提交者（initializer 提交 opening，TurnOrchestrator 提交 turn）追加。Runner / Claude 不得直接修改。是玩家视角的完整故事记录，用于前端展示和 Claude Code Runner 冷启动上下文。
_Avoid_: 完整世界状态、God State 日志、版本历史、checkpoint

### Story History Entry（故事历史条目）
玩家可见时间线中的统一条目。分为两类：`opening`（开场内容，无玩家输入）和 `turn`（正常回合，有玩家输入）。不同写入者（initializer、TurnOrchestrator 等）通过统一的受信任提交接口追加条目，条目类型和写入者身份在条目中记录。GET story 和前端展示读取的是统一的玩家可见时间线。
_Avoid_: 伪造"开始故事"玩家输入、区分不出开场与回合、由 Runner 直接修改 committed history

### Opening Entry（开场条目）
Story History Entry 的 `opening` 类型。由故事初始化流程（initializer）提交。不包含玩家 input，但必须进入完整的玩家可见历史、刷新后可恢复、出现在前端时间线的最前端。
_Avoid_: 不写入玩家可见历史、用假 input 伪装成 turn、刷新后丢失

### Turn Entry（回合条目）
Story History Entry 的 `turn` 类型。由 TurnOrchestrator 在回合成功提交后追加。包含 entryId、at、input（玩家输入）和 output（主角可见输出）。
_Avoid_: runner 日志、诊断记录

### Trusted History Committer（受信任历史提交者）
有权向 committed Story History 追加条目的系统组件。至少包括故事初始化流程（提交 opening entry）和 TurnOrchestrator（提交 turn entry）。Runner / Claude 仍然不得直接修改 committed history。
_Avoid_: 只允许 TurnOrchestrator 写入、让 Runner 绕过受信任接口直接追加

### Turn Interaction（回合交互状态）
叙事正文之外的交互元数据，属于受控的玩家可见输出。包含当前回合的交互模式（`continue` 或 `decision`），以及 Decision Point 模式下的当前戏剧问题和 0～4 个建议。存储在 `turn/interaction.json`，与 `turn/output.md`（叙事正文）分离。交互状态属于受控输出，不能从 agent stdout、任意日志或内部状态直接拼装；应被 snapshot/rollback 覆盖；刷新页面后应能恢复。缺失或格式错误时，Issue 10 的 plan 应定义降级行为。
_Avoid_: 把交互元数据混入叙事正文、从内部日志拼装交互状态、缺失时不降级

### Logical Character Agent（逻辑角色代理）
MVP 中"角色代理"首先是逻辑角色视角、私有角色状态和独立决策边界，不要求每个 NPC 启动独立进程、独立模型调用或独立 Runner。当前允许一个 Runner 在一个 Story Turn 中读取多个角色的私有状态、分别模拟各角色的目标判断和行为，同时保持角色之间的记忆与信息隔离。不要误解为每个 NPC 必须调用一次 Claude、当前阶段必须实现多 Agent 并行、或 Issue 8 必须拆多个独立运行时。
_Avoid_: 每个 NPC 独立进程、当前阶段多 Agent 并行、独立模型调用

### Authored Protagonist Runtime（预设主角运行时）
负责使用 Protagonist Core、稳定第一人称叙述声音、较充分的心理描写、自动生成低风险台词和自然反应、明确主角控制权边界、玩家本回合输入覆盖系统自动表现、重大关系与不可逆决定仍由玩家控制。不包括长期玩家行为推断、evidence/confidence 学习、显式长期偏好持久化或完整反馈 UI。
_Avoid_: 长期拟合混入运行时、反馈 UI 混入运行时

### Protagonist Feedback & Adaptation（主角反馈与适应）
负责本次纠正、长期偏好、Confirmed Adjustments、Inferred Tendencies、evidence/confidence、防止单次行为过拟合、明确反馈优先级、区分临时反应/角色关系倾向/稳定人格倾向。属于首个可玩版本后的增强项，不阻塞 MVP 可玩链路。
_Avoid_: 与主角运行时混淆、单次行为自动升级为稳定人格

## 架构边界

### 文件访问边界（Issue 3 起确立）

- **`workspace.ts` 是 Web / API / Turn Orchestrator 侧访问 Story Workspace 的统一入口。** 该侧代码（路由、orchestrator）读写 workspace 文件时，必须经由 workspace.ts 暴露的函数，不应直接使用 fs 操作 workspace 路径。
- **AgentRunner 不受此限制。** Runner 拿到传入的 `workspaceDir` 绝对路径后，可在该目录内直接用 fs 读写文件（如写 `turn/output.md`、`turn/done.json`）。这是有意设计，不是对 Issue 1-2 "workspace.ts 唯一磁盘入口" 不变量的破坏——该不变量只约束 Web/API/Orchestrator 侧。
- **理由**：Runner 天然需要写多个 workspace 文件（output、done，以及未来真实 agent 写 world/player 等），为每个文件在 workspace.ts 加包装函数是过度封装；未来真实 agent（Claude Code CLI）作为子进程也是直接操作文件，不会经过 workspace.ts。
- **后续约束**：Issue 4 在此边界内引入快照/回滚时，快照与回滚由 Orchestrator 通过 workspace.ts 统一编排；Runner 仍只负责在 workspaceDir 内写自己的产物。

## 关系

- 一个 **Story Turn** 可以包含零个或多个 **Random Judgments**。
- 一个 **Random Judgment** 通过一次 **Roll Choice** 产生一个 **Binding Random Outcome**。
- 一个成功提交的 **Random Judgment** 应产生一条对应的 **Random Log**。
- **Player-visible Output** 可以呈现 **Binding Random Outcome** 的可见后果，但不能直接展示 **Random Log**。
- 失败并回滚的 **Story Turn** 不保留本回合产生的 **Random Log**；只有成功回合的随机判定成为故事状态的一部分。
- **Claude Code Runner** 作为子进程执行回合时，经 Bash 工具调用 **Random Tool CLI Wrapper** 完成 **Roll Choice**；**Fake Agent Runner** 直接在进程内调用 `rollChoice` 库函数。两者产生相同的 **Random Log** 与 **Binding Random Outcome** 契约。
- **Runner 切换** 决定 **Turn Orchestrator** 持有哪个 **Agent Runner** 实例，但 **Turn Orchestrator** 的生命周期编排逻辑（锁、快照、磁盘权威、回滚）不随 runner 变化。
- 一个成功提交的 **Story Turn** 产生一条 **Turn Entry**，追加到 **Turn History**。
- 故事初始化流程产生一条 **Opening Entry**，追加到 **Turn History**。
- 失败/回滚的 **Story Turn** 不产生 **Turn Entry**。
- **Turn History** 是玩家视角的故事记录，不包含 God State、NPC 私有记忆或内部日志。
- **Turn History** 由 **Trusted History Committer** 追加；Initializer 提交 opening，TurnOrchestrator 提交 turn。Runner / Claude 不得直接修改。
- **Claude Code Runner** 读取 **Turn History** 作为玩家已见/已说的上下文，但不得修改或删除 **Turn History**。
- 一个正常 **Story Turn** 应至少产生一个玩家可感知的 **Meaningful Change**。
- **Narrative Turn Contract** 约束 **Story Turn** 的叙事逻辑，但不要求拆分新的 Agent Runtime，也不负责 continue/decision 数据结构或交互状态 API。
- **Character Intent** 可以影响 NPC 可见言行和后续状态，但 **hiddenIntent** 不得直接泄漏到 **Player-visible Output**。
- **Performance** 渲染的是主角可见、可感知、可合理推断的内容，仍受主角视窗隔离约束。
- **Adaptive Authored Protagonist** 由 **Authored Protagonist Runtime**（运行时行为）和 **Protagonist Feedback & Adaptation**（长期拟合与反馈）共同实现。
- **Authored Protagonist Runtime** 使用 **Protagonist Core**、稳定第一人称叙述声音和主角控制权边界，不包括长期拟合。
- **Protagonist Feedback & Adaptation** 负责 **Confirmed Adjustments**、**Inferred Tendencies** 和 **Explicit Feedback** 的长期持久化与学习，不阻塞 MVP 可玩链路。
- 主角模型优先级为：玩家本回合明确输入 → **Confirmed Adjustments** → **Protagonist Core** → 高置信 **Inferred Tendencies** → 低置信 **Inferred Tendencies** → 系统默认。
- **Player Agency** 高于自动演出：系统可以补全低风险表现方式，不能替玩家作关键关系、道德或不可逆决定。
- **Continuous Performance** 与 **Decision Point** 决定回合结尾形态；两者都不能绕过 **Meaningful Change** 要求。
- **Decision Point** 与 **Suggestion Gate** 的交互状态由 **Turn Interaction** 承载，与叙事正文（`turn/output.md`）分离。
- **Suggestion Gate** 只在 **Decision Point** 上提供输入辅助；建议填入输入框但不自动提交，不能移除自由输入。
- **Protagonist Control Boundary** 划分系统可自动演出与必须交还玩家的行为；系统可补全低风险表现方式，不能替玩家作关键关系、道德或不可逆决定。
- **Explicit Feedback** 高于系统推测；本次纠正只影响当前生成，长期偏好写入 **Confirmed Adjustments**。
- **Inner Monologue Guideline** 约束第一人称心理描写：应积极生成具体情绪和思考过程，不能长期停留在模糊中性表达，但不能擅自替玩家完成关键心理结论。
- **Logical Character Agent** 是 MVP 中角色代理的实现方式：逻辑角色视角和独立决策边界，不要求每个 NPC 独立进程或独立模型调用。
- **Turn Interaction** 属于受控的玩家可见输出，应被 snapshot/rollback 覆盖；缺失或格式错误时需降级处理，不得从内部日志拼装。

## 示例对话

> **Dev:** "主角撬锁失败是 agent 写得戏剧化一点，还是系统先判定？"
> **Domain expert:** "这是一次 **Random Judgment**。先用 **Roll Choice** 得到 **Binding Random Outcome**，agent 只能表演这个结果，不能重新选择成功或失败。"

> **Dev:** "玩家刷新页面后看不到之前的回合输出，怎么办？"
> **Domain expert:** "这需要 **Turn History**。成功回合的 **Turn Entry** 追加到 `turns/history.jsonl`，前端加载时读取并展示完整历史。"
> **Dev:** "那 runner 可以改这个文件吗？"
> **Domain expert:** "不可以。**Turn History** 只由 **Trusted History Committer** 追加——Initializer 提交 opening，TurnOrchestrator 提交 turn。Runner 只读不改。它是玩家视角的记录，不是 runner 的草稿。"
