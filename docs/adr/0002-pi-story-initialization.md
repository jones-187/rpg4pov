# Story Initialization 迁移到 Pi Runner

状态：已接受，分阶段实施（TDD 测试接缝已于 2026-08-23 确认）
日期：2026-08-23
审查固定点：`8806b361f14e8581f4661ff1e5ac10f8294bb5ba`

## 结论

真实运行模式统一使用一个 `PiRunner`：`Runner Task` 为 `init` 时生成并提交初始化内容，为 `turn` 时维持现有回合行为。`AgentRunner`、`TurnOrchestrator`、HTTP 接口以及锁、快照、回滚、输出隔离和 Trusted History Committer 不变量保持不变。

第一阶段新增 `AGENT_RUNNER=pi` 和 `docker-compose.pi.yml`，让 init/turn 都走 Pi；现有 `AGENT_RUNNER=claude` 暂时保留为 A/B 质量基线（仍是 turn→Pi、init→Claude）。只有真实初始化对比验收通过后，第二阶段才删除 Claude Code Runner、Claude settings、Claude prompt、容器内 Claude CLI 和旧 Compose 覆盖文件。

当前第一阶段实现状态：PiRunner 已按 `req.task` 选择 init/turn 计划；init 分为两个严格阶段：Phase 1 只写并校验完整 Init Workspace Bundle，应用后 Phase 2 只写 opening 的 output/interaction，服务端最终写 Done Marker。受控 write extension 接收 runner 注入的阶段 allowlist，在工具执行前拦截越权路径；每个阶段 attempt 结束后再以完整 workspace manifest 做纵深校验，失败交给 Orchestrator 快照回滚；opening context 只包含主角可见字段。Pi compose、fake-pi 链路和中性受控子进程 seam 已加入。Claude runner、settings、prompt、fixture 与专属测试仍保留用于 A/B 基线；首次 A/B 结果见 [`docs/acceptance/2026-08-23-pi-init-ab-acceptance.md`](../acceptance/2026-08-23-pi-init-ab-acceptance.md)。

## 原因

初始化已经预注入骨架并禁止文件探索，Claude CLI 的 agentic 文件探索不再提供实际价值。Pi 已验证能在一次模型回复中并行写 `turn/output.md`、`turn/interaction.json` 和 `turn/state-update.md`，并由服务端完成校验、状态合并和 Done Marker 提交。初始化的多文件生成是输出协议问题，不是 Pi 的能力限制。

统一后，调用方只需理解 `AgentRunner.runTurn(req)`；任务差异留在 Pi Runner 实现内部。真实运行不再维护两套 CLI、权限配置、prompt 和进程生命周期。

## 模块与接口

### 外部 seam：Agent Runner

稳定接口不变：

```ts
interface AgentRunner {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
```

`PiRunner.runTurn` 根据 `req.task ?? "turn"` 选择内部执行计划：

- `turn`：现有 Turn System Prompt、上下文预注入、随机数池和增量 State Update Bundle。
- `init`：无随机数池，先执行 Phase 1 概念计划，再执行 Phase 2 opening 计划；两阶段仍隐藏在同一次 `runTurn` 和同一个 Orchestrator abort/rollback 生命周期内。

初始化两个内部阶段的边界固定如下：

- Phase 1 概念计划预注入用户 canon 与初始化骨架，Pi 只能写 `turn/state-update.md`；服务端整体解析并校验 Bundle，要求四个 actor 结构标题后才 apply。
- Phase 2 opening 计划只读取服务端从已应用概念文件构造的 player-visible context：player 的初始状态/主角已知信息/Protagonist Core/Player Agency，以及 actor 标题/表面形象/voice。Pi 只能写 `turn/output.md` 与 `turn/interaction.json`，不得接触原始 setting、world/God State 或 actor 私有结构；两个候选都通过新鲜度和输出校验后才写 Done Marker。
- 两阶段各自使用 `PI_MAX_ATTEMPTS` 上限；Phase 2 重试不会重跑 Phase 1。Phase 2 最终失败时 Phase 1 已应用文件仍由 Orchestrator 快照整体回滚。

调用方不选择内部 prompt、产物解析器或重试策略；这些属于 Pi Runner 的实现。

### 外部 CLI seam：受控子进程

把通用 `SpawnFn`、`SpawnOpts`、`SpawnResult` 和 `defaultSpawn` 从 `claude-code-runner.ts` 移到中性模块。Pi Runner 只在这个外部进程 seam 注入测试替身。stdin/stdout 尾部缓冲、逐行事件和 abort/kill 语义保持不变。

Pi 原生 write 工具接受相对路径和绝对路径，不能把 cwd 当作权限边界。因此 Pi Runner 使用 `--no-extensions` 禁用自动发现，只显式加载仓库内受控 write extension；extension 在工具执行前接收 runner 强制注入的阶段 allowlist：Phase 1 仅允许 `turn/state-update.md`，Phase 2 仅允许 `turn/output.md`、`turn/interaction.json`，turn 才允许三者；所有路径都必须是字面量 POSIX 相对路径，并拒绝绝对路径、目录穿越、相似路径和符号链接。init 每个阶段再对 spawn 前后的整个 Story Workspace 做 manifest 对比；除本阶段候选文件外的任何新增、删除或改写都立即失败且不重试，由 Orchestrator 快照回滚。

### 初始化 Bundle 与 opening

Pi 初始化现在分两阶段写候选文件：

1. Phase 1 只写 `turn/state-update.md`：完整 Init Workspace Bundle。
2. 服务端整体校验并应用概念文件后，Phase 2 只写 `turn/output.md`（开场主角视窗）与 `turn/interaction.json`（开场交互状态）。

初始化 Bundle 使用完整文件段，不复用回合的 APPEND/REPLACE 增量语义：

```text
=== FILE: world.md ===
# 世界设定
...
=== FILE: player.md ===
# 主角
...
=== FILE: rules.md ===
# 规则
...
=== FILE: actors/keeper.md ===
# 守塔人
...
```

服务端在写入 Story Workspace 前完成整体解析与形状校验：

- 必须且只能包含一份 `world.md`、`player.md`、`rules.md`。
- 至少一张 `actors/*.md`；只允许 `actors/` 下一层的 `.md` 文件。正常未指定人数的设定由 prompt 要求生成 3–5 个核心 NPC；用户 canon 明确要求更少角色时优先服从 canon，因此服务端不机械强制最少 3 张。
- 拒绝绝对路径、目录穿越、重复文件、空内容及占位内容。
- 拒绝 `story.md`、`turns/**`、`turn/input.md`、`adjustments.md`、`tendencies.md` 和其他路径。
- Bundle 无效时不得应用任何概念文件，当前 Phase 1 attempt 进入重试；所有 Phase 1 attempt 失败时不写 Done Marker，由 Orchestrator 统一回滚。
- 模型对 Bundle 外路径的 write 调用在执行前被受控 extension 拒绝；若仍产生越权变化，init workspace manifest 会令本轮失败并触发回滚。

Bundle 通过后才批量写入概念文件。Phase 2 只接收服务端筛选的 player-visible opening context；Phase 2 完成且 output/interaction 均通过校验后，才由服务端写 `turn/done.json`。模型永远不直接写故事正式文件或 Done Marker。

## 执行与失败语义

- `init` 和 `turn` 都使用 Pi 的无会话冷启动、工具收窄、事件流、mtime 新鲜度门、自动重试和渐进终止。
- `turn` 继续要求现有 output/interaction 行为并允许 state-update 缺失降级；init Phase 1 只要求新鲜且完整的 Bundle，Phase 2 只要求新鲜且有效的 output/interaction。每阶段 manifest 都只使用本阶段 allowlist。
- `init` 不生成或消费 Pre-rolled Random Pool。
- 初始化开场可以复用现有叙事先行预览，但只有 Phase 2 的 output 与 interaction 两个本 attempt 事件都到齐后，才用本次 interaction 原文作 output 泄密指纹；预览仍非权威，失败或重试时撤回。
- 初始化概念文件应用后，仍由 Orchestrator 执行 `validateInitWorkspace`、输出隔离、受保护路径逐字比对、Opening Entry 提交和 Initialized Marker 提交。
- 任一步失败都由现有快照恢复整个 Story Workspace。
- 单次 Bundle 曾出现角色结构与开场隔离难以同时稳定满足的质量风险；因此按本 ADR 的退路规则触发两阶段 Pi 调用（概念 Bundle → player-visible opening），不放宽质量门。第一阶段真实 A/B 记录见 acceptance 报告；后续若 Phase 2 仍失败，优先由 Orchestrator 回滚整轮并继续保留 Claude 基线。

## Prompt 约束

Pi Init System Prompt 必须保留现有初始化契约：

- 用户明确设定是 canon，只能补全不能改写。
- 小场景、有限地点和时间跨度，不预写固定剧本、路线或结局。
- 生成 world、player、rules 和至少一张核心 NPC 卡。
- Player 包含 Protagonist Core 与 Player Agency 边界。
- NPC 包含 Emotional Core、Relationship State、Emotionally Salient Memories 和 Current Intent。
- 默认第一人称主角限知；不得在 output 泄漏 God State、NPC 私有记忆、hiddenIntent 或私有情感状态。
- 初始化不得写 adjustments、tendencies、story、history 或 turn input。
- Phase 1 必须调用 write 工具写完整 Bundle 候选，且不能写 output/interaction；Phase 2 只能写 output/interaction，不能写 state-update 或 done。两个阶段的正式提交与 Done Marker 都由服务端负责。

## 分阶段迁移与删除

第一阶段（本次实现）：

- 新增 Pi Init Prompt、Init Workspace Bundle 和 PiRunner 的 init 执行计划。
- `AGENT_RUNNER=pi` 使用单一 Pi Runner；`AGENT_RUNNER=claude` 暂时维持现状，只用于质量基线和回退。
- 新增 `docker-compose.pi.yml`，保留现有 Claude Compose。
- 把通用子进程实现移到中性模块，但不删除 Claude Runner。
- 审计 `claude-prompt.test.ts` 中记录的产品契约：所有仍适用于初始化的要求必须迁移为 Pi Init Prompt 测试；不得以“旧实现已死”为由静默删除需求覆盖。现有 Story Turn 已走 Pi，适用于 turn 的要求应由 `pi-prompt` 测试承接或明确记录为既有差异，不在本次迁移中盲目扩充热路径 prompt。
- 更新 README、CONTEXT 和 ADR 0001，说明两种真实配置及 Pi 初始化的候选状态。
- 历史 issue/验收记录保留过去事实，不改写成当前实现。

第二阶段（真实质量验收通过后另行实施）：

- 删除 `ClaudeCodeRunner`、Claude settings、fake-claude fixture 及其专属测试。
- 删除容器内 `@anthropic-ai/claude-code`、Claude settings 构建步骤和不再需要的运行时包。
- 删除 `AGENT_RUNNER=claude`、旧 Compose 覆盖文件和仅供 Claude 使用的 prompt/常量；需要保留的通用常量迁到中性领域模块。

## 非目标

- 不改变模型或 provider 配置，仍使用现有 Pi 配置与 `qwen-fp8` 默认值。
- 不改变 HTTP 请求/响应、页面交互、Workspace 布局或 Turn History 结构。
- 不引入新 AgentRunner 接口、任务分发 adapter、多 Agent、会话复用或远程 API。
- 自动测试不访问真实模型或真实网关；第一阶段完成后另跑有明确成本的 HITL A/B 验收。

## 验收标准

1. `AGENT_RUNNER=pi` 时，`init` 与 `turn` 均由同一个 Pi Runner 执行；`AGENT_RUNNER=claude` 暂时保留原分流；默认仍为 Fake Agent。
2. Pi 初始化成功后，Phase 1 应用的 world/player/rules/actors、Phase 2 生成的开场 output/interaction、Done Marker、Opening Entry 和 Initialized Marker 全部正确提交。
3. 用户 canon 设定进入 Init Prompt；初始化不注入随机数池。
4. 无效、缺失、陈旧或越权 Phase 1 Bundle，以及越权/不完整 Phase 2 opening，不得部分污染正式概念文件；各阶段重试耗尽后初始化失败并由 Orchestrator 回滚。
5. 现有 Story Turn 的随机判定、状态增量、预览、新鲜度门和重试行为不回归。
6. 第一阶段 Docker 同时支持 Pi 候选路径和 Claude 基线路径；第二阶段质量门通过后才移除 Claude CLI。
7. 旧初始化 prompt 中仍有效的产品契约已经迁移到 Pi Init Prompt 测试，没有因实现替换而丢失需求覆盖。
8. TypeScript 类型检查、相关定向测试、完整测试和生产构建全部通过。

## 真实质量门（删除 Claude 前必须通过）

使用相同模型、provider、超时和至少 5 组代表性设定，对 Pi init 与 Claude init 做同题 A/B。设定至少覆盖：canon 信息密集、单/少 NPC 明确约束、关系/情感场景、秘密/风险场景、显式非默认 POV。

硬门槛（任一失败即不得删除 Claude）：

- 用户 canon 无丢失或冲突。
- world/player/rules/actors 结构完整，正常设定生成 3–5 个核心 NPC；显式人数 canon 得到服从。
- 每张核心角色卡包含 Emotional Core、Relationship State、Emotionally Salient Memories 和 Current Intent。
- 开场遵守指定 POV、主角限知与输出隔离，无 God State/NPC 私有状态泄漏。
- 初始化成功率不低于 Claude 基线，失败能完整回滚。

软质量比较：人物区分度、关系自然度、开场可玩压力、是否避免固定剧情、叙事声音。盲评结果不得显示 Pi 有一致性劣化。若单 Bundle 是主要问题，优先拆成两次 Pi 调用，不直接降低内容要求。

## TDD 测试接缝（已确认）

1. `PiRunner.runTurn` seam：在外部 CLI 进程处注入 `SpawnFn`，通过 Story Workspace 的公开结果验证 init 成功、无效 Bundle 重试/失败、turn 回归。
2. Init Workspace Bundle seam：通过一个“解析并应用 Bundle”的小接口验证允许路径、必需文件、原子拒绝与完整落盘，不测试私有解析步骤。
3. `POST /api/stories/{storyId}/initialize` seam：用 fake-pi 子进程替身跑真实 Pi Runner + Orchestrator，验证 HTTP 响应、Opening Entry、Initialized Marker、canon 与隔离。
4. `resolveRunner` seam：验证 `AGENT_RUNNER=pi` 暴露单一 Pi Runner，默认仍暴露 Fake Agent。
5. 受控子进程 seam：保留 stdout 尾部缓冲、逐行旁路与 abort 行为测试，迁移到中性模块。
