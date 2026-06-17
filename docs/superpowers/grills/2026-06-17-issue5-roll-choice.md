# Issue 5 Grill 结果：工具真随机（roll-choice 端到端验证）

> **日期**: 2026-06-17
> **作者**: zhangxiaofa
> **状态**: 默认决策已锁定，未留开放裁决
> **Grill 范围**: Random Tool、Roll Choice、Random Log、随机结果绑定、Fake Agent/测试回合集成、失败与回滚边界
> **CONTEXT.md 变更**: 新增随机相关术语与关系

---

## 议题背景

Issue 5 的目标行为（来自 `docs/issue.md`）：

> 系统提供一个随机工具，支持“候选项 + 权重/概率”的判定。Fake Agent 或测试回合可以调用该工具，随机结果写入 random log，并被用于生成本回合主角可见响应。

要验证的链路：

```text
agent 不自己假装随机
→ 调用随机工具
→ 工具生成结果
→ 写入 random log
→ 故事输出服从随机结果
```

Issue 5 不解决真实 Claude Code Runner、不做公开随机 API、不做随机日志可视化、不做完整 controller 判定模型。

---

## 已锁定基线

现有文档和代码已经给出以下边界：

- **Player-visible Output** 只来自 `turn/output.md`，不读 `logs/`、stdout、world、player、actors。
- **Agent Runner** 可以在 `workspaceDir` 内直接读写文件；**Turn Orchestrator** 仍只通过 `workspace.ts` 读写自己的侧边界。
- **Turn Orchestrator** 的成功权威仍是 `turn/done.json` + 非空 `turn/output.md`，不会在 Issue 5 改成 random log 监管者。
- `logs/.gitkeep` 从 Issue 2 起就是内部日志目录占位，Issue 5 的 Random Log 应落在 `logs/` 内。
- Issue 4 的整目录回滚会恢复 `logs/`，因此失败回合内写出的 Random Log 默认随回滚删除。

---

## 决策记录

### Q1: Issue 5 验收对象是随机工具 seam，还是默认 Web 回合也必须随机？

**选择**: 验收对象是 **Random Tool seam + 回合内集成**；默认 Web 路由不必须改成每回合随机。

**理由**:
- Issue 文案写的是 “Fake Agent 或测试回合可以调用”，不是强制现有 `FakeAgentRunner` 每回合随机。
- 当前 `FakeAgentRunner` 已被 Issue 3/4 用作稳定闭环和安全边界验证件，直接改变默认语义会让回归测试失焦。
- Issue 5 的核心是证明工具、日志、绑定结果可用；真实默认运行时要到 Issue 6/8 才接。

**验收方式**: 新增随机集成 runner 或 controlled test runner，经 `TurnOrchestrator` 跑完整回合，证明输出服从随机结果。

---

### Q2: roll-choice 是库函数、CLI，还是两者都要？

**选择**: Issue 5 先锁定 **领域模块/库函数契约**；CLI 语法不在本 issue 固化。

**理由**:
- `docs/arch-prd.md` 明确把详细随机工具 CLI 语法排除在架构 PRD 外。
- 当前 Fake Agent 和测试在 TypeScript 内运行，最小可验证路径是 `src/lib` 领域模块。
- 未来 CLI agent 需要调用命令行时，可以包一层 CLI，但不应反过来让 CLI 参数格式驱动领域模型。

**Issue 6 留口**: 接入真实 Claude Code Runner 时，如需 shell 调用随机工具，应基于本模块增加 CLI wrapper 或等价调用方式；Issue 5 不提前固化 CLI 参数语法。

---

### Q3: roll-choice 输入模型怎么定？

**选择**:

```ts
type RollChoiceRng = () => number;

type RollChoiceCandidate = {
  id: string;
  label?: string;
  weight: number;
};

type RollChoiceInput = {
  storyId: string;
  workspaceDir: string;
  rollId: string;
  candidates: RollChoiceCandidate[];
  rng?: RollChoiceRng;
};

type RollChoiceResult = {
  rollId: string;
  selectedId: string;
  selectedCandidate: RollChoiceCandidate;
  sample: number;
  randomSource: "crypto" | "injected";
};
```

约束：

- `id` 必须稳定且唯一。
- `rollId` 由调用方提供，必须是非空字符串；Issue 5 不强制全局唯一，但测试中应使用清晰的语义 rollId。
- `workspaceDir` 由调用方提供；Random Tool 使用传入的 `workspaceDir` 写 `logs/random-rolls.jsonl`，不自己猜 workspace 路径。
- `weight` 必须是有限正数。
- 所有 candidate weight 相加后的 `totalWeight` 必须是有限正数；`totalWeight` 非 finite 时抛错。
- MVP 使用 `weight` 作为规范字段；调用方已有“概率”时按权重传入即可。
- 不允许空候选、重复 id、零权重、负权重、NaN/Infinity。
- 单候选合法；仍调用 RNG 并记录 `sample`，但 `selectedId` 必然为唯一候选。

**理由**:
- 稳定 `id` 是日志、输出绑定和未来状态回放的最小锚点。
- 权重比“概率总和必须等于 1”更稳，避免浮点总和误差和混用语义。

---

### Q4: 随机源用什么？

**选择**: 生产默认使用 `crypto` 级随机；测试可注入确定性 RNG。

**理由**:
- PRD 要求真实随机或程序随机，模型不能假装随机。
- 测试必须避免概率型 flaky；注入 RNG 才能稳定断言边界。

**测试约定**: 注入返回 `[0, 1)` 的 deterministic RNG，用它覆盖权重边界和 selected outcome。`rng` 必须返回有限 number；`NaN`、`Infinity`、负数、`>= 1` 都应抛错，并由 Orchestrator 触发 rollback。

---

### Q5: Random Log 放哪里、叫什么、什么格式？

**选择**: `logs/random-rolls.jsonl`，JSONL，一次 Roll Choice 一行。

每行最小字段：

```json
{
  "at": "2026-06-17T00:00:00.000Z",
  "storyId": "...",
  "rollId": "...",
  "type": "roll-choice",
  "candidates": [{ "id": "success", "label": "成功", "weight": 35 }],
  "selectedId": "fail",
  "randomSource": "crypto",
  "sample": 0.73
}
```

**理由**:
- `logs/turn-errors.log` 已采用 JSONL，沿用同类日志形态。
- 一行一条天然支持同回合多次随机判定。
- 记录候选项、权重和选中结果，满足审计需要；不做玩家可见日志。

**写入契约**: `rollChoice` 选出结果后必须 append random log。Random Log 写入失败时，`rollChoice` 抛错；runner 不应继续写 `turn/output.md` 或 `turn/done.json`，失败交给 Turn Orchestrator rollback。

---

### Q6: Random Log 是故事状态还是执行审计？

**选择**: 成功回合的 Random Log 是故事状态的一部分；失败回合内产生的 Random Log 随回滚删除。

**理由**:
- Random Log 解释的是“已提交故事结果为何发生”，而不是失败执行的底层诊断。
- Issue 4 已把 `turn-errors.log` 作为失败后补写的内部执行日志；Random Log 不承担这个职责。
- 失败回合不应留下未提交随机事实，否则会把未发生的故事判定写进状态。

---

### Q7: 一个回合是否允许多次 Roll Choice？

**选择**: 允许，同一回合可以追加多条 `logs/random-rolls.jsonl`。

**理由**:
- 真实故事里一个回合可能同时判定撬锁、NPC 是否察觉、同伴是否犹豫。
- JSONL 成本很低，从第一天支持多条比之后迁移格式更稳。

---

### Q8: Fake Agent 如何集成随机？

**选择**: 不改现有默认 `FakeAgentRunner`；新增随机集成 runner 或测试 runner。

**理由**:
- 现有 Fake Agent 是架构闭环和安全边界的稳定替身，保持它固定输出更利于 Issue 4/9 回归。
- Issue 5 只需要一个能调用 Random Tool 的 runner 来证明 seam，不需要改变默认 Web 行为。

---

### Q9: 如何证明随机结果被绑定到主角可见响应？

**选择**: 用确定性 RNG 做双向验收：

- RNG 选中 `success` 时，`turn/output.md` 必须包含 success 对应的可见后果。
- RNG 选中 `fail` 时，`turn/output.md` 必须包含 fail 对应的可见后果。
- `logs/random-rolls.jsonl` 的 `selectedId` 必须与输出后果一致。

**不选择**: 让 Turn Orchestrator 在运行时解析 output 并校验 log/output 一致。

**理由**:
- 当前 Orchestrator 的职责是生命周期、安全与固定输出读取；把“叙事内容是否服从随机结果”塞进 Orchestrator 会提前做 controller。
- Issue 5 的正确粒度是 runner/tool seam 的契约测试。

---

### Q10: roll-choice 失败算什么失败？

**选择**:

- 输入非法：Random Tool 抛错，runner 返回失败或抛错，Orchestrator 回滚。
- 随机源异常：同上。
- Random Log 写入失败：本回合失败并回滚。

**理由**:
- PRD 明确随机结果必须记录；“结果用了但没日志”会破坏审计。
- Issue 4 已有失败回滚与 `turn-errors.log`，随机工具失败直接走现有失败路径即可。
- runner 捕获 `rollChoice` 错误后可以返回 `{ success: false, error }`，也可以让错误冒泡；两种都会由 Orchestrator 判定失败并回滚。

---

### Q11: 是否新增公开 Web/API endpoint？

**选择**: 不新增 `/api/random` 或任何玩家可直接调用的随机接口。

**理由**:
- PRD 说 agent 调随机工具，不是玩家调随机工具。
- 公开 endpoint 会扩大攻击面，并诱导把内部随机机制暴露给主角视窗。
- random log viewer 是 P2/Future，不属于 MVP。

---

### Q12: 如何避免概率型 flaky 测试？

**选择**:

- 禁止用“跑 N 次看分布”作为 CI 验收。
- 使用 deterministic RNG 覆盖权重边界和输出绑定。
- 只保留一个 production random smoke test，验证 crypto 随机源可返回合法候选，不断言分布。

**理由**: Issue 5 要证明契约，不要用随机性本身制造不稳定测试。

---

## 最终验收边界

Issue 5 完成时应能证明：

1. Random Tool 接收候选项 + 权重，选出一个合法候选。
2. 生产默认随机源不是模型生成，测试可注入确定性 RNG。
3. 每次成功 Roll Choice 追加一条 `logs/random-rolls.jsonl`。
4. 日志记录候选项、权重、随机源和选中结果。
5. 集成 runner 能把 Binding Random Outcome 写入 `turn/output.md`。
6. Web/API 返回仍只来自 `turn/output.md`，不会泄漏 Random Log。
7. 随机工具输入错误、随机源错误、日志写入失败都会导致回合失败并回滚。
8. 失败回合不保留本回合随机日志；失败诊断仍走 `logs/turn-errors.log`。
9. 集成测试覆盖 Web/API response 只返回 `turn/output.md`，即使 `logs/random-rolls.jsonl` 存在也不会泄漏。

---

## 不创建 ADR 的理由

本 issue 的决策延续 Issue 2-4 已锁定的架构边界：Markdown-first Story Workspace、Runner 直接写 workspace、Orchestrator 负责生命周期、日志位于 `logs/`。这些不是新的难逆转架构取舍；未来读者可以从 `CONTEXT.md` 与本 grill 记录理解原因，不需要单独 ADR。
