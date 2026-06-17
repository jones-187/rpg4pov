# Issue 3 Grill 结果：用 Fake Agent 跑通单回合 Story Turn 闭环

> **日期**: 2026-06-16
> **状态**: 决策已锁定，待第二意见审查
> **Grill 范围**: Agent Runtime Adapter 接口、回合生命周期、Fake Agent 职责、文件访问边界

---

## 议题背景

Issue 3 的目标行为（来自 `docs/issue.md`）：

> 用户在故事页输入内容，系统把输入写入当前 Story Workspace，然后通过 Agent Runtime Adapter 调用 Fake Agent Runner。Fake Agent 写入固定主角可见输出，后端只读取固定输出并返回页面。

核心架构闭环：

```
Web 输入
→ Story Turn API
→ Agent Runtime Adapter
→ Fake Agent Runner
→ Story Workspace
→ 固定 player response
→ Web 展示
```

**Issue 3 不做**：真实 agent（Issue 6）、随机工具（Issue 5）、串行锁/快照/回滚（Issue 4）、故事初始化 agent（Issue 7）。

---

## 现有代码基线

Issue 1-2 已完成，当前代码结构：

```
src/
├── lib/
│   └── workspace.ts          # 唯一文件系统领域模块
├── app/
│   ├── api/
│   │   ├── stories/
│   │   │   ├── route.ts      # POST 建 / GET 列
│   │   │   └── [storyId]/
│   │   │       └── route.ts  # GET 取单个
│   │   └── story-turn/
│   │       └── route.ts      # 占位回合逻辑
│   ├── stories/
│   │   └── [storyId]/
│   │       └── page.tsx      # 故事页
│   └── page.tsx              # 首页（故事列表）
```

当前 `story-turn/route.ts` 直接做占位逻辑：写 input → 写占位 output → 读 output → 返回。Issue 3 要用 AgentRunner + TurnOrchestrator 替换占位逻辑。

### 当前 workspace.ts 的 API

| 函数 | 职责 | Issue 3 后变化 |
|------|------|---------------|
| `resolveWorkspaceRoot()` | 返回 workspace 根目录 | 保留 |
| `isValidStoryId(id)` | UUID v4 校验 | 保留 |
| `workspaceExists(storyId)` | 检查 workspace 是否存在 | 保留 |
| `createStory(opts?)` | 创建故事 + 骨架 | 保留 |
| `listStories()` | 列出所有故事 | 保留 |
| `getStory(storyId)` | 获取单个故事元数据 | 保留 |
| `readTurnOutput(storyId)` | 读 turn/output.md | 保留 |
| `writeTurnInput(storyId, input)` | 写 turn/input.md | 保留 |
| `writeTurnOutput(storyId, content)` | 写 turn/output.md | **删除**（runner 直接 fs 写） |

---

## 决策记录

### Q1: Agent Runner 接口的入参与返回值

**问题**: AgentRunner 接口应该接收什么、返回什么？

**选项**:
- **方案1**: Runner 写文件，返回仅 `{ success, error? }`。Orchestrator 从文件读取输出。
- 方案2: Runner 返回内容 `{ success, playerResponse, error? }`，Orchestrator 写文件。
- 方案3: 混合——Runner 写文件 + 返回内容供校验。

**选择**: 方案1

**理由**:
- PRD P0-9 "Workspace 是唯一事实来源" + P0-15 "agent 直接写 workspace" → runner 必须写文件
- PRD P0-18/19 "Web 只返回固定输出，不返回 stdout" → orchestrator 必须从文件读取
- HTTP runner 是 P1/P2 的事，不需要在 P0 接口预支复杂度
- 方案3 的"两个 source of truth 需要校验"是过度设计

**最终接口**:
```ts
interface TurnRequest {
  storyId: string;
  workspaceDir: string;   // 绝对路径，runner 不需要自己算
  playerInput: string;    // 便利字段，runner 可选用
}

interface TurnResult {
  success: boolean;
  error?: string;         // 内部诊断信息
}

interface AgentRunner {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
```

---

### Q2: 回合生命周期编排

**问题**: 谁负责编排"写 input → 调 runner → 读 output"这个流程？

**选项**:
- **方案A**: TurnOrchestrator 类编排，route 是薄层
- 方案B: Route 自己编排，runner 只是一步

**选择**: 方案A

**理由**:
- PRD Decision-3 "编排逻辑在 React 外" → 编排逻辑属于 Story Engine，不应散在 HTTP 路由
- Issue 4 的 snapshot/rollback 会显著增加编排复杂度，现在不抽到时候 route 膨胀
- 用户规则: 方法 < 30 行、文件 < 500 行 → 方案B 在 Issue 4 后会超标
- Orchestrator 可独立测试，不需要模拟 HTTP Request/Response

---

### Q3: 运行成功标记的形式

**问题**: PRD P0-11 要求"运行成功标记"，如何实现？

**选项**:
- **方案1**: 独立文件 `turn/done.json`
- 方案2: `turn/output.md` 的 front matter 标记
- 方案3: output.md 存在即成功（隐式标记）

**选择**: 方案1

**理由**:
- PRD P0-11 把"运行成功标记"和"固定输出"列为两个独立约定
- Issue 4 的 rollback 需要可靠判断"回合是否完整完成"——独立文件无歧义（存在/不存在）
- front matter 方案有"写了一半"的歧义
- 隐式标记无法区分"runner 写了一半崩了"和"runner 成功写了短输出"

**done.json 格式**:
```json
{ "status": "success", "completedAt": "2026-06-16T12:00:00.000Z" }
```

---

### Q4: Fake Agent Runner 的职责边界

**问题**: Fake Agent 应该读什么、写什么？

**读什么**: 读 `turn/input.md`（或用 `playerInput` 字段），把输入反映到输出中
- 理由: 如果 Fake Agent 完全忽略输入，无法端到端验证"输入被正确传递"

**写什么**: 只写 `turn/output.md` + `turn/done.json`
- 理由: Issue 3 目标是"跑通闭环"，不是"模拟完整 agent 行为"。写 world.md/player.md 是 Issue 6+ 的事。写太多反而让 Issue 4 的 snapshot/rollback 测试变复杂

**Fake Agent 输出格式**:
```md
# 主角视窗

（Fake Agent 固定输出）

你选择了：{input 的内容}

周围一切安静。没有特别的事情发生。
```

---

### Q5: Runner 注入方式

**问题**: TurnOrchestrator 如何获得 AgentRunner 实例？

**选项**:
- **方案A**: 构造注入，模块级单例
- 方案B: 无状态函数，Runner 作为参数传入
- 方案C: 模块级可变单例 + setRunner

**选择**: 方案A

**理由**:
- Runner 在应用生命周期内不变，构造时确定
- 构造注入满足可测试性——测试时 `new TurnOrchestrator(fakeRunner)`
- 避免方案C 的全局可变状态

**形态**:
```ts
// src/lib/turn-orchestrator.ts
export class TurnOrchestrator {
  constructor(private runner: AgentRunner) {}
  async executeTurn(storyId: string, playerInput: string): Promise<TurnOutcome> { ... }
}

// src/app/api/story-turn/route.ts
const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
```

**TurnOutcome**（Orchestrator → Route）:
```ts
interface TurnOutcome {
  success: boolean;
  playerResponse: string | null;  // success 时从 turn/output.md 读取
  error?: string;                 // failure 时的内部信息
}
```

注意: `TurnOutcome.playerResponse` 和 `TurnResult` 不同——`TurnResult` 是 runner 返回的（只有 success/error），`TurnOutcome` 是 orchestrator 返回的（包含从文件读取的 playerResponse）。

---

### Q6: Runner 的文件访问方式

**问题**: Runner 通过 workspace.ts 访问文件，还是直接 fs？

**选项**:
- 方案A: Runner 通过 workspace.ts 的函数
- 方案B: Runner 直接 fs，通过 resolveWorkspaceRoot 定位
- **方案C**: Runner 拿到 workspaceDir 绝对路径，自己决定写什么

**选择**: 方案C

**理由**:
- YAGNI: workspace.ts 的"唯一磁盘入口"不变量是为 Issue 1-2 的简单场景设计的。Issue 3 引入 runner 后，runner 天然需要写多个文件，为每个文件加函数是过度封装
- Runner 接收 `workspaceDir`，在这个目录里读写——这是 runner 的职责
- Orchestrator 仍然通过 workspace.ts 读 output（readTurnOutput、readTurnDone）
- 未来真实 agent（Claude Code）也是直接操作文件，不会通过 workspace.ts

**职责边界**:
- **workspace.ts**: Web 侧对 workspace 的唯一访问入口（读 + 生命周期管理）
- **AgentRunner**: 在 workspaceDir 内自由读写（直接 fs）
- **TurnOrchestrator**: 编排，不直接 fs

---

### Q7: 判断回合成功的权威来源

**问题**: Orchestrator 信任 runner 返回值，还是检查磁盘？

**选项**:
- 方案A: 信任 runner 返回值
- **方案B**: 检查磁盘（done.json）为权威

**选择**: 方案B

**理由**:
- PRD "Workspace 是唯一事实来源"——也应适用于回合状态
- Issue 4 的 snapshot/rollback 需要基于磁盘状态判断
- 未来真实 runner（Claude Code）是子进程，可能崩溃/超时/被 kill——不会优雅返回 `{ success: false }`
- 多一次文件读取的代价可忽略

---

### Q8: workspace.ts 的 API 变更

**问题**: 哪些函数需要新增/删除？

**删除**: `writeTurnOutput(storyId, content)`
- Issue 3 后由 runner 直接 fs 写入，orchestrator 不再调用
- YAGNI: 没有调用者就是死代码
- Issue 2 的测试需要同步修改

**新增**:
- `readTurnDone(storyId): Promise<DoneMarker | null>` — orchestrator 读取 done.json
- `clearTurnDone(storyId): Promise<void>` — orchestrator 回合开始前清理旧标记
- `resolveWorkspaceDir(storyId): string` — orchestrator 构造 TurnRequest 时获取路径

---

### Q9: TurnRequest.playerInput 是否多余

**问题**: Runner 已经能从 turn/input.md 读输入，playerInput 字段是否冗余？

**选择**: 保留

**理由**:
- playerInput 和 input.md 内容一致，不是两个 source of truth，而是同一 truth 的两种传递方式
- Fake Agent 可直接用 playerInput，避免多一次文件读取
- 未来 HTTP runner 天然需要这个字段
- 删除它对架构没有简化

---

### Q10: workspaceDir 如何暴露给 Orchestrator

**问题**: workspace.ts 的私有函数 `workspaceDir()` 如何暴露？

**选择**: 导出 `resolveWorkspaceDir(storyId)`，含 storyId 校验

```ts
export function resolveWorkspaceDir(storyId: string): string {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  return path.resolve(resolveWorkspaceRoot(), storyId);
}
```

**理由**:
- workspace 布局是 workspace.ts 的核心职责，路径构造不应泄漏
- 与已有 `resolveWorkspaceRoot` 命名一致
- Issue 4 的 snapshot 也需要知道 workspace 目录路径

---

### Q11: done.json 的初始状态

**问题**: createStory 骨架是否包含 done.json？

**选项**:
- 方案A: 骨架包含 `turn/done.json`（状态 pending）
- **方案B**: 骨架不含，runner 执行后才创建

**选择**: 方案B

**理由**:
- "不存在 = 未完成"是最直觉的语义
- Orchestrator 在写 input.md 之前删除旧 done.json，是自然的"回合开始"信号
- Issue 4 的 rollback 更简单——回滚后 done.json 不存在，自然表示回合失败
- 方案A 的 pending 状态在 runner 崩溃时不会被清理，导致"永远 pending"的僵尸状态

---

### Q12: Runner 异常处理

**问题**: Runner 的 runTurn() 抛异常时，Orchestrator 怎么办？

**选择**: Orchestrator 捕获异常，转为失败，统一走磁盘检查

**修正（grill 回顾阶段发现）**: catch 后不直接返回，而是统一走磁盘权威检查：

```ts
let result: TurnResult;
try {
  result = await this.runner.runTurn(req);
} catch (err) {
  result = { success: false, error: "runner crashed" };
}
// 统一走磁盘权威检查（与 Q7 一致）
const done = await readTurnDone(storyId);
if (!done || done.status !== "success") {
  return { success: false, playerResponse: null, error: result.error ?? "done marker missing" };
}
```

**理由**:
- Orchestrator 是回合生命周期管理者，应对所有失败负责
- Issue 4 的 rollback 需要在 orchestrator 内完成
- PRD Decision-41 "Failed turns return a simple retry message"——用户不应看到 500
- 统一走磁盘检查，主流程只有一条路径，不是打补丁

---

## 最终架构

### 文件结构

```
src/
├── lib/
│   ├── workspace.ts              # 改：删 writeTurnOutput，新增 readTurnDone/clearTurnDone/resolveWorkspaceDir
│   ├── agent-runner.ts           # 新：AgentRunner 接口 + TurnRequest/TurnResult 类型
│   ├── fake-agent-runner.ts      # 新：FakeAgentRunner 实现
│   └── turn-orchestrator.ts      # 新：TurnOrchestrator + TurnOutcome 类型
├── app/
│   └── api/
│       └── story-turn/
│           └── route.ts          # 改：薄层，调 TurnOrchestrator
└── tests/
    ├── lib/
    │   ├── workspace.test.ts     # 改：删 writeTurnOutput 测试，加 readTurnDone/clearTurnDone 测试
    │   ├── fake-agent-runner.test.ts  # 新
    │   └── turn-orchestrator.test.ts  # 新
    └── api/
        └── story-turn.test.ts    # 改：适配新架构
```

### 回合执行流程

```
story-turn/route.ts (薄层: HTTP 解析 + NextResponse)
  │
  ▼
TurnOrchestrator.executeTurn(storyId, playerInput)
  │
  ├── 1. workspace.ts: clearTurnDone(storyId)         — 清理上回合标记
  ├── 2. workspace.ts: writeTurnInput(storyId, input)  — 写入主角输入
  ├── 3. workspace.ts: resolveWorkspaceDir(storyId)    — 获取绝对路径
  ├── 4. 构造 TurnRequest { storyId, workspaceDir, playerInput }
  ├── 5. AgentRunner.runTurn(req)                      — 调用 runner (catch 异常)
  │     └── FakeAgentRunner:
  │           读 turn/input.md (或用 playerInput)
  │           写 turn/output.md (fs)
  │           写 turn/done.json (fs)
  │           返回 { success: true }
  ├── 6. workspace.ts: readTurnDone(storyId)           — 检查磁盘权威状态
  │     └── done.json 不存在或非 success → 返回失败
  └── 7. workspace.ts: readTurnOutput(storyId)         — 读取主角可见输出
        └── 返回 { success: true, playerResponse }
```

### 职责边界

| 组件 | 职责 | 文件访问 |
|------|------|---------|
| workspace.ts | Web 侧对 workspace 的唯一访问入口（读 + 生命周期管理） | 通过自身函数 |
| AgentRunner | 在 workspaceDir 内执行回合，写 output.md + done.json | 直接 fs |
| TurnOrchestrator | 编排回合生命周期，不直接 fs | 通过 workspace.ts |
| story-turn/route.ts | HTTP 解析 + 调 orchestrator + 包 NextResponse | 不访问文件 |

---

## PRD 对照

| PRD 条目 | 满足情况 | 决策来源 |
|---------|---------|---------|
| P0-5 Agent Runtime Adapter | ✓ AgentRunner interface | Q1/Q5 |
| P0-9 Workspace 唯一事实来源 | ✓ runner 写文件，orchestrator 从文件读 | Q1/Q7 |
| P0-11 固定输入/输出/成功标记/随机日志位置 | ✓ input.md / output.md / done.json / logs/ | Q3/Q11 |
| P0-14 每回合冷启动 | ✓ FakeAgentRunner 无状态 | Q4 |
| P0-15 agent 直接写 workspace | ✓ runner 直接 fs | Q6 |
| P0-18/19 Web 只返回固定输出，不返回 stdout | ✓ orchestrator 只读 output.md | Q1/Q7 |
| Decision-3 编排逻辑在 React 外 | ✓ TurnOrchestrator 独立模块 | Q2 |
| Decision-12 Adapter 是稳定边界 | ✓ AgentRunner interface | Q1 |
| Decision-19 保留替换 runner 能力 | ✓ 构造注入 | Q5 |
| Decision-28 Workspace 唯一来源 | ✓ 磁盘权威 | Q7 |
| Decision-30 Agent 读 workspace | ✓ Fake Agent 读 input.md | Q4 |
| Decision-31 Agent 直接写 workspace | ✓ | Q6 |

---

## YAGNI 检查

| 检查点 | 评估 |
|-------|------|
| TurnResult 只有 success + error | ✓ 没有预支 timeout/retry 等字段（留给 Issue 4） |
| TurnOutcome 只有 3 个字段 | ✓ |
| FakeAgentRunner 只写 2 个文件 | ✓ 不模拟真实 agent 写 world.md 等 |
| 不引入 pending 状态 | ✓ 不存在 = 未执行 |
| TurnOrchestrator 是类 | ✓ 需要持有 runner 状态，函数不够 |
| 不为 HTTP runner 预留接口 | ✓ P0 不需要 |

---

## 架构检查（避免打补丁式修改）

| 检查点 | 评估 |
|-------|------|
| AgentRunner interface | ✓ 正交抽象，不是在 route 上打补丁 |
| TurnOrchestrator | ✓ 新模块，职责清晰 |
| done.json | ✓ 独立标记文件，不在 output.md 上打补丁 |
| resolveWorkspaceDir | ✓ 新导出函数，不改现有函数签名 |
| 删除 writeTurnOutput | ✓ 清理死代码，不留兼容层 |
| 异常处理统一走磁盘检查 | ✓ 主流程只有一条路径 |

---

## 待第二意见审查的关键点

1. **AgentRunner 接口只返回 success/error，不返回内容** — 是否过于激进？真实 agent 场景下是否需要 runner 返回更多诊断信息？
2. **Runner 直接 fs 写文件，不经过 workspace.ts** — 是否打破了 Issue 1-2 建立的"workspace.ts 唯一磁盘入口"不变量？这个打破是否合理？
3. **done.json 作为独立成功标记** — 是否有必要？能否用更简单的方式（如 output.md 存在即成功）？
4. **TurnOrchestrator 作为类 + 构造注入** — 是否过度设计？是否应该用更简单的函数式方案？
5. **磁盘权威 vs runner 返回值** — 是否应该信任 runner 返回值，减少一次文件读取？
6. **删除 writeTurnOutput** — 是否应该保留以备后用？
