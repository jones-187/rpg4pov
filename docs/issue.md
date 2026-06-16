下面是基于“产品 PRD + 技术架构 PRD”的 **第一版垂直切分草案**。我按“每个 issue 做完都能 demo / 验证一个端到端行为”来切，没有按模块横切。

## 拟拆分 Issues

### 1. 启动 Docker 化极简 Web 故事壳

**Type**: AFK
**Blocked by**: None - can start immediately
**User stories covered**: 技术架构 PRD US 1-5, 11-19, 61-64

**目标行为**：用户能通过浏览器打开本地 Web 页面，看到故事显示区、输入框和发送按钮。提交输入后，后端返回一个占位故事响应。应用可以通过 Docker 单容器启动，并暴露 Web 端口。

这是第一个 tracer bullet：虽然还没有 Story Workspace 和 agent，但已经有 UI → API → response → Docker 的完整路径。

------

### 2. 创建 storyId 并生成独立 Markdown Story Workspace

**Type**: AFK
**Blocked by**: Issue 1
**User stories covered**: 技术架构 PRD US 8-10, 28-35, 49-54

**目标行为**：用户创建一个新故事，系统生成 storyId，并创建该 storyId 对应的 Markdown-first Story Workspace。页面进入该 storyId 的故事页。不同 storyId 的 workspace 互相隔离。

这一片完成后，系统从“单页面玩具”变成“有故事会话和持久故事空间”的原型。

------

### 3. 用 Fake Agent 跑通单回合 Story Turn 闭环

**Type**: AFK
**Blocked by**: Issue 2
**User stories covered**: 技术架构 PRD US 21-25, 28-38, 61-63

**目标行为**：用户在故事页输入内容，系统把输入写入当前 Story Workspace，然后通过 Agent Runtime Adapter 调用 Fake Agent Runner。Fake Agent 写入固定主角可见输出，后端只读取固定输出并返回页面。

这一片是核心架构闭环：

```text
Web 输入
→ Story Turn API
→ Agent Runtime Adapter
→ Fake Agent Runner
→ Story Workspace
→ 固定 player response
→ Web 展示
```

还不接真实 agent，先把边界跑稳。

------

### 4. 加入安全执行边界：固定输出、串行、快照、失败回滚

**Type**: AFK
**Blocked by**: Issue 3
**User stories covered**: 技术架构 PRD US 35-48, 61-63

**目标行为**：同一个 storyId 同一时间只能执行一个回合。每回合执行前创建快照。Fake Agent 成功时正常返回固定输出；Fake Agent 超时、失败、未生成固定输出或基础校验失败时，系统回滚到回合前状态，并向用户展示可重试的失败提示。

这一片把“agent 直接写 workspace”的风险压住，防止半成品状态污染故事。

------

### 5. 加入工具真随机：roll-choice 端到端验证

**Type**: AFK
**Blocked by**: Issue 3
**User stories covered**: 技术架构 PRD US 55-60

**目标行为**：系统提供一个随机工具，支持“候选项 + 权重/概率”的判定。Fake Agent 或测试回合可以调用该工具，随机结果写入 random log，并被用于生成本回合主角可见响应。

这一片验证：

```text
agent 不自己假装随机
→ 调用随机工具
→ 工具生成结果
→ 写入 random log
→ 故事输出服从随机结果
```

------

### 6. 接入 Claude Code CLI Runner 作为首个真实 Agent Runtime

**Type**: HITL
**Blocked by**: Issue 4
**User stories covered**: 技术架构 PRD US 21-27, 29-30, 66-67

**目标行为**：Agent Runtime Adapter 增加 Claude Code CLI Runner。Web 层仍只依赖 Adapter，不直接感知 Claude Code。用户输入后，系统冷启动 Claude Code Runner，让它在当前 storyId 的 Story Workspace 内完成一个回合，并写入固定主角可见输出。

标为 HITL 的原因：这里需要人工确认本地 Docker 环境、凭证注入方式、Claude Code CLI 在容器内的实际可用性，以及首版 agent prompt 是否足够稳定。实现本身可以交给 agent，但验收需要人实际跑通一次。

------

### 7. 用自然语言初始化故事 Workspace

**Type**: AFK
**Blocked by**: Issue 6
**User stories covered**: 技术架构 PRD US 50-54

**目标行为**：用户输入一个小场景故事设定，初始化 agent 基于该设定生成可玩的 Story Workspace，包括世界设定、主角、核心 NPC、基础规则、初始状态和开场主角视窗。用户提供的明确角色卡内容必须优先保留。

完成后，用户不需要手动编辑文件就能开始一个故事。

------

### 8. 打通最小真实可玩链路：创建故事 → 初始化 → 第一个真实回合

**Type**: HITL
**Blocked by**: Issue 5, Issue 6, Issue 7
**User stories covered**: 技术架构 PRD US 1-7, 50-60, 61-67, 72-75；产品 PRD 中主角视窗、NPC 私有记忆、随机、失败后果相关 MVP 用户故事

**目标行为**：用户从 Web 页面输入小场景设定，系统创建 storyId，初始化 Story Workspace，然后用户输入主角第一回合行动。真实 CLI agent 读取 workspace、必要时调用随机工具、更新故事文件、写入固定 player response，Web 页面展示主角视窗文本。

这是 MVP 的第一条完整可玩 tracer bullet。标为 HITL，因为需要人工体验判断：故事是否能玩、主角视窗是否基本成立、Claude Code Runner 是否没有明显跑偏。

------

### 9. 强化主角视窗输出隔离与内部日志不外泄

**Type**: AFK
**Blocked by**: Issue 4
**User stories covered**: 技术架构 PRD US 6-7, 35-39, 61-63；产品 PRD 中 God State / NPC Memory / Random Log 不对用户可见的故事

**目标行为**：系统明确验证页面只展示固定 player response。即使 agent stdout、内部日志、God State、NPC Memory、random log 中存在内容，也不会被 Web 返回给用户。固定输出缺失或格式明显不合规时，回合失败并回滚。

这个 issue 和 Issue 4 有关联，但更聚焦“主角视窗隔离”的产品风险，可以在真实 Runner 接入前后都跑。



------

## 推荐第一轮执行范围

我建议第一轮只放进 MVP 必做：

```text
Issue 1
Issue 2
Issue 3
Issue 4
Issue 5
Issue 6
Issue 7
Issue 8
Issue 9
```

## 依赖关系简图

```text
1. Docker Web 壳
   ↓
2. storyId + Workspace
   ↓
3. Fake Agent 单回合
   ↓
4. 安全执行边界
   ↓          ↘
6. Claude Runner   5. 随机工具
   ↓              ↘
7. 故事初始化       ↘
   ↓                ↘
8. 最小真实可玩链路
```

`9. 输出隔离强化` 依赖 Issue 4，可以在 Issue 6 前后做。