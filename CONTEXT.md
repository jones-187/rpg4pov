# 项目术语表 (Glossary)

本文件是领域术语表，记录项目中关键概念的规范定义。不含实现细节。

## 故事相关

### Story Workspace
每个 storyId 对应的独立工作空间，是故事状态的**唯一事实来源**。采用 Markdown-first 布局，包含故事元数据、世界设定、主角信息、NPC 角色卡、日志和回合输入输出。

### Story Turn（故事回合）
用户输入主角行动后，系统执行的一次完整处理周期。一个回合从用户输入开始，到返回主角可见输出结束。同一 storyId 的回合串行执行。

### Player-visible Output（主角可见输出）
回合完成后，用户能通过 Web 界面看到的内容。**只来自 `turn/output.md`**，不包含 agent stdout、内部日志、God State、NPC 私有记忆或随机判定日志。

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
已提交的玩家可见回合历史，存储在 `turns/history.jsonl`。每条记录包含 turnId、at、input、output。只由 TurnOrchestrator 在成功回合提交阶段追加。是玩家视角的完整故事记录，用于前端展示和 Claude Code Runner 冷启动上下文。
_Avoid_: 完整世界状态、God State 日志、版本历史、checkpoint

### History Entry（历史条目）
Turn History 中的单条记录。包含：
- turnId: 唯一标识符（UUID）
- at: ISO 时间戳
- input: 玩家输入（主角行动/台词）
- output: 主角可见输出
_Avoid_: runner 日志、诊断记录

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
- 一个成功提交的 **Story Turn** 产生一条 **History Entry**，追加到 **Turn History**。
- 失败/回滚的 **Story Turn** 不产生 **History Entry**。
- **Turn History** 是玩家视角的故事记录，不包含 God State、NPC 私有记忆或内部日志。
- **Claude Code Runner** 读取 **Turn History** 作为玩家已见/已说的上下文，但不得修改或删除 **Turn History**。

## 示例对话

> **Dev:** "主角撬锁失败是 agent 写得戏剧化一点，还是系统先判定？"
> **Domain expert:** "这是一次 **Random Judgment**。先用 **Roll Choice** 得到 **Binding Random Outcome**，agent 只能表演这个结果，不能重新选择成功或失败。"

> **Dev:** "玩家刷新页面后看不到之前的回合输出，怎么办？"
> **Domain expert:** "这需要 **Turn History**。成功回合的 **History Entry** 追加到 `turns/history.jsonl`，前端加载时读取并展示完整历史。"
> **Dev:** "那 runner 可以改这个文件吗？"
> **Domain expert:** "不可以。**Turn History** 只由 **Turn Orchestrator** 追加，runner 只读不改。它是玩家视角的记录，不是 runner 的草稿。"
