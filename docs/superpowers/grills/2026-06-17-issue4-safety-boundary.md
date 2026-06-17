# Issue 4 Grill 结果：安全执行边界（固定输出、串行、快照、失败回滚）

> **日期**: 2026-06-17
> **状态**: 决策已锁定，待第二意见审查
> **Grill 范围**: 串行执行锁、快照范围与位置、回滚粒度与失败响应、超时机制（触及 Issue 3 接口）、基础校验
> **CONTEXT.md 变更**: 新增术语 `Turn Snapshot（回合快照）`

---

## 修订记录

**2026-06-17（生成 plan 前的 review 修正）**：大方向认可，修正 3 处关键点：

1. **失败路径顺序**：`restoreSnapshot` 必须在 `appendTurnError` **之前**。`logs/turn-errors.log` 位于 `workspace/logs/` 下，属于整目录快照/恢复范围；先写日志再整目录回滚会把日志条目覆盖丢失。
2. **快照时机**：`createSnapshot` 必须在 `clearTurnDone` **之前**（lock 后第一步）。Turn Snapshot 表示"本回合开始前的完整状态"（与 CONTEXT.md 术语一致）；clearTurnDone 是本回合第一个 mutation，回滚须精确恢复含上回合 done.json 的提交态。下一回合开始时仍 clearTurnDone，不影响 done 权威判断。
3. **Runner Contract 强化**：AgentRunner **必须**响应 `TurnRequest.signal`；abort 后须停止并 reject / 返回失败；真实 CLI Runner 须把 signal 传到子进程层。不接受 Promise.race-only 实现。原 Q4 措辞"Fake Agent 可忽略 signal"过松——若 runner 可忽略 signal，A 方案退化为 B 的幽灵写入风险，故 signal 响应是 contract 强制项而非可选优化。

---

## 议题背景

Issue 4 的目标行为（来自 `docs/issue.md`）：

> 同一个 storyId 同一时间只能执行一个回合。每回合执行前创建快照。Fake Agent 成功时正常返回固定输出；Fake Agent 超时、失败、未生成固定输出或基础校验失败时，系统回滚到回合前状态，并向用户展示可重试的失败提示。

覆盖 PRD：US 35-48, 61-63（串行、快照、回滚、超时、校验、失败响应）。

**Issue 4 不做**：真实 agent（Issue 6）、随机工具（Issue 5）、故事初始化（Issue 7）、主角视窗输出隔离的系统化强化（Issue 9，Issue 4 只做 done.json 权威 + 非空兜底）。

---

## 现有代码基线（Issue 1-3 完成后）

```
src/
├── lib/
│   ├── workspace.ts           # Web 侧唯一 workspace 入口（含 readTurnDone/clearTurnDone/resolveWorkspaceDir）
│   ├── agent-runner.ts        # AgentRunner 接口 + TurnRequest/TurnResult（Issue 3 锁定）
│   ├── fake-agent-runner.ts   # FakeAgentRunner（瞬时、零外部依赖）
│   └── turn-orchestrator.ts   # TurnOrchestrator + TurnOutcome
└── app/api/story-turn/route.ts # 薄层：校验 → workspaceExists → orchestrator → 200/500
```

**Issue 3 grill 已确立、Issue 4 必须遵守的约束**：

- `TurnOrchestrator` 是"单回合生命周期编排者"（Q2），不直接 fs，通过 workspace.ts 读写。
- `done.json` 的**磁盘存在性 = 回合成功权威**（Q7），不存在/非 success = 失败。
- `output.md` 必须存在且非空（`trim() !== ""`）才成功。
- `TurnResult` 只有 `{ success, error? }`，**没有 timeout 字段——这是 Issue 3 主动留给 Issue 4 的债**（YAGNI 检查明文）。
- CONTEXT.md「文件访问边界」：快照/回滚由 Orchestrator 通过 workspace.ts 统一编排；Runner 仍只负责在 workspaceDir 内写自己的产物。

---

## 决策记录

### Q1: 串行执行——第二个并发回合怎么办？

**场景**: 用户双击发送，或同故事开两 tab 同时提交。两个 `POST /api/story-turn` 针对同 storyId 毫秒级到达。Fake Agent 瞬时；真实 Claude Code（Issue 6）秒到分钟级。第二个请求的命运？

**选项**:
- **A. 立即拒绝第二个，返回 HTTP 409 "故事正在执行"**；锁用进程内 `Map<storyId, ...>`
- B. 排队，第二个请求挂起等第一个跑完再返回
- C. workspace 内 lock 文件（`turn/.lock`），存在即拒绝

**选择**: A + **独立模块 `src/lib/turn-lock.ts`**

**理由**:
1. **YAGNI / US 48 "ignore complex concurrency"**：排队要管理等待超时、顺序、请求生命周期、前端轮询，全部超出 MVP。拒绝 + 手动重试 = 一个 loading 态够用。
2. **B 挂起 HTTP 请求几分钟**（Issue 6 真实 agent）很脆：Next.js serverless/边缘部署不友好，代理会超时，前端没有比"提示重试"更好的 UX。
3. **C 的 lock 文件正好命中我们正在防的失败模式**：进程崩溃 → 留下僵尸 `.lock` → 故事永久锁死，需人工清。**进程内 Map 随进程死亡 = 重启自动安全复位**。US 10 保证的是故事**数据**跨重启持久化，不是锁状态——瞬态锁本不该跨重启存活。
4. **HTTP 409 是干净、稳定的契约**，Issue 6+ 直接复用；前端 loading 态禁用按钮即可（本来就该禁）。
5. **单 Docker 容器 = 单 Node 进程**，进程内 Map 够用；MVP 不需跨进程协调。

**锁的范围**: 覆盖 `executeTurn` 的完整生命周期（clear done → snapshot → write input → runner → 检查 done → 读 output → 释放）。

**锁崩溃的职责划分**: 进程在回合中途崩溃时锁自动消失，但 workspace 可能停在半成品状态——**那是回滚机制的活，不是锁的职责**。两件事分开。

**独立模块 vs 塞进 orchestrator**: 选独立模块。`TurnOrchestrator` 按 Issue 3 grill Q2 是"单回合生命周期编排者"，混入并发控制会让它在 Issue 6 后膨胀；锁可独立测试。

---

### Q2: 快照——范围多大、放哪？

**场景**: 真实 Claude Code（Issue 6）一个回合改 world.md、actors/、turn/output.md、turn/done.json，第 5 个文件写到一半崩了。done.json 没写 → 触发失败 → 要回滚。

**范围选项**:
- **A. 整个 workspace 目录**（除快照自身外全量拷贝）
- B. 只快照"已知可变文件"清单（turn/、world.md、player.md、actors/、logs/）

**位置选项**:
- **X. workspace 外，`{WORKSPACE_ROOT}/.snapshots/{storyId}/`**
- Y. workspace 内，`{workspace}/.snapshot/`

**选择**: A + X（整目录 + workspace 外）

**理由**:
1. **范围选整目录（A），这是反 YAGNI 的正确例外**。Selective 清单（B）是 bug 工厂：Issue 6 真实 agent 可能写任何文件，清单漏一个 → 回滚不干净 → 半成品状态，**正好是 Issue 4 要消灭的东西**。这里"省"换来的是正确性缺陷。
2. **位置选 workspace 外（X），守住 CONTEXT.md「workspace 是唯一事实来源」**。快照是瞬态恢复机制，不是故事内容。放 workspace 内（Y）有二病：① 递归快照自身要 exclude，易错；② 未来真实 agent（直接 fs 读写 workspace）可能把 `.snapshot/` 当故事文件读进去污染上下文。
3. **`.snapshots/` 放 WORKSPACE_ROOT 下**：与 workspace 同卷，移动/备份一致；`listStories` 已用 `isValidStoryId` 过滤 readdir 结果，`.snapshots` 不是 UUID → **自动被忽略，零改动**。
4. **格式用纯目录递归拷贝**（Node `fs.cp` 递归），不 tar/zip——MVP 不需压缩/版本历史（版本历史是 PRD P1-15）。**只保留一份，回合前覆盖上一份**。

**CONTEXT.md 更新**: 新增术语 `Turn Snapshot（回合快照）`——明确"不是 Story Workspace 的一部分、不是故事状态、存活期不超过一次回合、放 workspace 外"，Avoid 标注"版本历史/备份/checkpoint"。

---

### Q3: 回滚后 workspace 状态 + 用户看到什么？

**场景**（接 Q2）：用户输入"我向守卫拔剑" → clear done → **快照**（input.md 还是上一回合的）→ 写新 input.md → 调 runner → runner 半路崩 → 失败 → **回滚**。

回滚后三个文件状态：

| 文件 | 回滚后 | 说明 |
|------|--------|------|
| `world.md` / `player.md` / `actors/` | 上一回合结束时 | ✓ 干净 |
| `turn/output.md` | 上一回合的旧输出 | ✓ 干净 |
| **`turn/input.md`** | **上一回合的旧 input**（非本次） | ⚠️ 用户本次输入丢了 |
| `turn/done.json` | 不存在 | ✓ 自然 |

**核心问题**: 用户刚提交的输入是否在回滚后保留？

**选项**:
- **A. 回滚 = 完整恢复到快照态，input.md 回到上一回合**；用户本次输入**只通过 HTTP 响应**返回（`{ error, retryInput }`），前端填回输入框供重试
- B. 回滚后**重新写入本次 input.md**（恢复其他文件，但 input 保留本次）
- C. 完整恢复，不回传本次输入，让用户自己重新打字

**选择**: A

**理由**:
1. **"回滚"语义要纯粹**（CONTEXT.md 定义为"瞬态恢复机制"）：回滚 = 整目录恢复到快照点。B 让 input 成为"恢复了一半"的混合态，破坏回滚原子性——**正是 Issue 4 要消灭的半成品状态**。要留 input 就别叫完整回滚。
2. **"故事持久状态"和"用户输入"是两个东西**。world/player/output 属于故事状态，回滚掉是对的（runner 没成功写）。input.md 本质是用户输入的临时载体，它的"权威副本"是用户的提交，不是磁盘。用 HTTP 响应回传 input 是干净的职责分离。
3. **B 的诱惑是"用户重试时 input.md 已有"**，但重试本质是发起**新回合**，会重新走 clear→snapshot→writeTurnInput——B 的"便利"无用，还污染语义。
4. **C 太不友好**：用户输入长文本（角色台词）时重打字是真实痛点。

**HTTP 状态码**: 沿用 500（route 已用）。MVP 不值得为 HTTP 语义精确度分码，US 41 只要"simple retry message"。

---

### Q4: 超时机制（触及 Issue 3 锁定的 AgentRunner 接口）

**场景**（Issue 6 预演）: Fake Agent 瞬时测不出超时。真实 Claude Code spawn 子进程，可能：① 正常 30s 写完；② 挂起等 API 卡 5 分钟；③ 子进程崩了但没抛 JS 异常。US 43 要求 "timeout handling around agent execution, so that a stuck agent does not block the app forever"。

**核心问题**: 超时怎么传给 runner、runner 怎么响应？

**选项**:
- **A. `AgentRunner.runTurn(req)` 增加 signal（放 TurnRequest 内）；Orchestrator 用 `AbortSignal.timeout(ms)` 创建，超时则 abort + 判失败**
- B. 不改接口，只用 `Promise.race(runner, timeout)`——超时后不管 runner 是否还在后台跑
- C. 不做超时（留给 Issue 6）

**选择**: A + signal 放 TurnRequest + 60s/`TURN_TIMEOUT_MS` + 统一走回滚

**理由**:
1. **B 有真实隐患**：`Promise.race` 赢了超时，但 runner 的子进程（Issue 6 Claude Code）**仍在后台运行并写文件**。刚回滚清干净，后台 runner 可能紧接着写文件回去——**直接破坏 Issue 4 的核心保证**（Q1 锁释放后，下一回合的快照可能抓到这个幽灵写入）。B 不是"不做超时"，是"做了但没做干净"。
2. **C 明显违反 US 43**——P0 明文要求。Fake Agent 下测不出，但接口要为 Issue 6 就位；否则 Issue 6 要二次改 `AgentRunner` 接口，违背 CONTEXT.md「adapter 是稳定边界」。
3. **A 是 Node 标准**（`AbortSignal.timeout` 内建、`fs` 和 `child_process.exec` 原生支持 abort）。Fake Agent 实现**监听 signal 即可**（或干脆不监听——Fake Agent 瞬时完成，超时永不触发，signal 是 no-op）。**给 Fake Agent 零负担**。
4. **修改 Issue 3 接口不是"打补丁"**——加 `signal` 参数是**补全 Issue 3 故意留下的口子**，方向正确。

**4a 超时时长**: 60 秒（够真实 agent 一个回合，Issue 6 单回合通常 < 30s，又不过长干等）。可经 `TURN_TIMEOUT_MS` 覆盖。

**4b 超时算"失败 → 回滚"还是单独一类**: 统一走回滚（与崩溃、output 空、done 缺失同一条失败路径）。YAGNI：US 42 要"内部日志记录失败原因"，但**对用户都是"请重试"**，分类是 P1（"agent 执行超时、重试和失败原因分类"）。只有 `error` 字符串区分（`"timeout"` / `"runner crashed"` / `"done marker missing"` / `"output missing"`）。

**4c signal 放法**: 放 `TurnRequest`（而非 `runTurn` 第二参数）。`TurnRequest` 本就是"一回合并所有上下文"，signal 是回合级的，概念内聚；Fake Agent 测试构造 req 时传 `AbortSignal.timeout(5000)` 即可。

**不提 ADR 的理由**: ADR 三条标准检验——① hard to reverse（medium）、② surprising（**weak**：AbortSignal 是 Node 标准取消模式，读者不困惑）、③ real trade-off（是）。第②条不满足。但 **Q4 选 A 而非 B 的关键理由（B 的超时后幽灵写入会破坏回滚原子性）非显然**，plan 作者必须知晓。

---

### Q5: 基础校验边界 + 失败响应最终形态（收口）

#### (a) 基础校验边界（US 45）

当前 orchestrator 只做 `playerResponse.trim() === ""`（非空）。

**选择**: **维持 trim 非空，不加任何新门槛**

**理由**:
1. **最小长度是魔法数**——真实 agent 可能写很短的合法输出（角色沉默、简短反应），门槛误杀。
2. **格式校验过早**——Fake Agent 输出是纯 markdown `# 主角视窗...`，但未来真实 agent 的 output 格式未定（Issue 6+）。现在定格式 = 把未定的事提前锁死。
3. **黑名单穷举不了**——"agent 把内部日志写进 output.md"是 Issue 9（输出隔离强化）的主战场。Issue 4 用 done.json 权威 + 非空兜底够。
4. **PRD P1-6 明文**："更严格的 workspace 校验"是 P1。Issue 4 是 P0，"basic" = 非空即可。
5. **占位符 case 已被覆盖**——createStory 写的初始 `turn/output.md` 占位符，若 runner 失败没覆盖它，会被"done.json 不存在"先捕获，轮不到 output 校验。

#### (b) 失败响应最终形态

```jsonc
// 成功（已有，保留）
{ "playerResponse": "..." }                              // HTTP 200

// 失败（timeout / 崩溃 / done 缺失 / output 空 / 校验失败）
{ "error": "回合执行失败，请重试", "retryInput": "..." }   // HTTP 500

// 并发拒绝（Q1 锁）
{ "error": "故事正在执行，请稍候" }                       // HTTP 409，无 retryInput
```

- 用户只看固定中文提示，**不暴露内部 error 分类**（timeout/crashed/done missing/output missing 只进 `logs/` 内部日志，US 42）。
- `retryInput` 回填输入框（Q3 已定）。409 不带 retryInput——用户输入还在前端输入框里，没丢。

#### (c) 内部错误日志位置

**选择**: `workspace/logs/turn-errors.log`（追加写，JSONL）

**理由**: 与 PRD P0-11 "logs/ 位置约定"一致，且 logs/ 已在 createStory 骨架里。

---

## 最终架构（plan 作者直接用）

### 新增/改动文件

```
src/
├── lib/
│   ├── turn-lock.ts          # 新：进程内 Map<storyId>，acquire/release，同 storyId 第二次 acquire 抛 TurnBusyError
│   ├── turn-snapshot.ts      # 新：createSnapshot(storyId) / restoreSnapshot(storyId)，纯 fs.cp 递归，路径 {WORKSPACE_ROOT}/.snapshots/{storyId}/
│   ├── turn-error-log.ts     # 新（可选，或并入 workspace.ts）：appendTurnError(storyId, { reason, at, storyId, input? })
│   ├── workspace.ts          # 改：可能新增 resolveSnapshotsDir / appendTurnError；listStories 零改动（isValidStoryId 已过滤）
│   ├── agent-runner.ts       # 改：TurnRequest 新增 signal: AbortSignal
│   ├── fake-agent-runner.ts  # 改：runTurn 接收 signal（Fake Agent 瞬时，可忽略；为完整性可加 signal.throwIfAborted）
│   └── turn-orchestrator.ts  # 改：编排锁 + snapshot + 超时 + 回滚；executeTurn 内部 try/finally 保证锁释放
└── app/api/story-turn/route.ts  # 改：区分 409（TurnBusyError）/ 500（失败带 retryInput）
```

### executeTurn 编排（修订版，覆盖锁的全生命周期）

```
executeTurn(storyId, playerInput):
  1. lock.acquire(storyId)                      — 失败抛 TurnBusyError → route 转 409
  try:
    2. clearTurnDone(storyId)                    — 清理上回合 done.json
    3. createSnapshot(storyId)                   — 整目录拷贝到 .snapshots/{storyId}/（workspace 外）
    4. writeTurnInput(storyId, playerInput)      — 写入本次输入
    5. resolveWorkspaceDir(storyId)              — 获取绝对路径
    6. signal = AbortSignal.timeout(TURN_TIMEOUT_MS ?? 60000)
    7. req = { storyId, workspaceDir, playerInput, signal }
    8. try: result = await runner.runTurn(req)
       catch: result = { success: false, error: "runner crashed" }
    9. done = readTurnDone(storyId)
       if !done || done.status !== "success"  → 走失败路径
    10. playerResponse = readTurnOutput(storyId)
        if !playerResponse || trim==="" → 走失败路径
    11. return { success: true, playerResponse }
  finally:
    lock.release(storyId)

失败路径（统一）:
    - reason = result.error ?? "done marker missing" / "output missing"
    - appendTurnError(storyId, { reason, at, storyId })   — 写 logs/turn-errors.log
    - restoreSnapshot(storyId)                            — 整目录恢复到快照点（input.md 回到上一回合）
    - return { success: false, playerResponse: null, error: reason }
```

**注意点（plan 作者必读）**:

- **快照时机在 clearTurnDone 之后、writeTurnInput 之前**——快照捕获"上一回合结束时的 workspace"，回滚 = 回到上一回合状态。
- **AbortSignal.timeout 是 Node 18.17+ 内建**——确认项目 Node 版本支持（package.json engines / Next.js 要求）。若不支持，用 `setTimeout` 手动 `controller.abort()`。
- **AbortSignal.timeout 一旦触发即 abort，不可逆**——Fake Agent 瞬时不会触发；真实 runner（Issue 6）需在子进程层响应 abort。Issue 4 只需保证 Orchestrator 层超时判失败 + 回滚。
- **Q4 选 A 非 B 的关键**：B（纯 Promise.race）的超时后幽灵写入会破坏回滚原子性——任何"省事"用 Promise.race 的诱惑都要拒绝。
- **回滚后 input.md 是上一回合的旧 input**，本次输入只能通过 HTTP `retryInput` 回传（Q3）。前端失败时回填输入框。
- **409 不带 retryInput**——用户输入还在前端输入框（请求根本没进入回合处理）。
- **restoreSnapshot 实现要小心**：整目录恢复时，需先清空目标 workspace 再拷贝，避免 runner 新增的文件残留。或用 `fs.cp` 的覆盖语义确认。

### 职责边界（修订）

| 组件 | 职责 | 文件访问 |
|------|------|---------|
| workspace.ts | Web 侧 workspace 唯一入口 + 可能新增 snapshot 路径/错误日志 | 自身函数 |
| turn-lock.ts | 进程内并发控制，per-storyId 互斥 | 不访问文件（纯内存） |
| turn-snapshot.ts | 整目录快照/恢复，路径在 workspace 外 | 直接 fs（.snapshots/ 在 workspace 外，不属于 workspace.ts 管辖） |
| AgentRunner | 在 workspaceDir 内写 output.md + done.json；接收 signal | 直接 fs |
| TurnOrchestrator | 编排锁 + snapshot + 超时 + 回滚；try/finally 保证锁释放 | 通过 workspace.ts + turn-lock + turn-snapshot |
| story-turn/route.ts | HTTP 解析 + 区分 409/500 + 包 NextResponse | 不访问文件 |

---

## PRD 对照

| PRD 条目 | 满足情况 | 决策来源 |
|---------|---------|---------|
| US 35 固定主角可见输出 | ✓ orchestrator 读 output.md（Issue 3 已实现，Issue 4 保持） | Q5 |
| US 36 运行成功标记 | ✓ done.json 权威（Issue 3 已实现，Issue 4 保持） | Issue 3 |
| US 37 内部日志与 player 输出分离 | ✓ logs/turn-errors.log（内部）vs output.md（player） | Q5c |
| US 38 agent 直接写 workspace | ✓ runner 直接 fs（Issue 3，Issue 4 不改） | Issue 3 |
| US 39 回合前快照 | ✓ turn-snapshot.ts，整目录，workspace 外 | Q2 |
| US 40 失败回滚 | ✓ restoreSnapshot，统一失败路径 | Q3 |
| US 41 失败返回简单重试消息 | ✓ "回合执行失败，请重试" + retryInput | Q3/Q5 |
| US 42 失败内部日志 | ✓ logs/turn-errors.log JSONL | Q5c |
| US 43 超时处理 | ✓ AbortSignal.timeout(60s)，signal 进 TurnRequest | Q4 |
| US 44 缺固定输出算失败 | ✓ trim 非空校验（Issue 3 已实现，Issue 4 保持） | Q5a |
| US 45 基础输出校验 | ✓ 维持非空，不加门槛（P1 才加严） | Q5a |
| US 46-48 同 storyId 串行 | ✓ turn-lock.ts，进程内 Map，409 拒绝 | Q1 |
| US 61-63 不流式、loading+最终响应、不返回中间态 | ✓ 失败也是整回合后才返回（不暴露中间态） | Q3 |

---

## YAGNI 检查

| 检查点 | 评估 |
|-------|------|
| 锁用进程内 Map 而非 Redis/DB | ✓ 单容器单进程，US 48 "ignore complex concurrency" |
| 锁只存内存不持久化 | ✓ 瞬态，重启复位 |
| 快照单份覆盖而非版本历史 | ✓ 版本历史是 P1-15 |
| 快照纯 fs.cp 不压缩 | ✓ MVP 不需 tar/zip |
| 超时 60s 固定 + env 覆盖 | ✓ 不做分阶段超时（P1） |
| 超时统一走回滚不分失败类 | ✓ 分类是 P1 |
| 校验维持非空不加门槛 | ✓ 严校验是 P1-6 |
| 409 不带 retryInput | ✓ 用户输入还在前端 |
| 不做排队 | ✓ US 48 |

---

## 架构检查（避免打补丁）

| 检查点 | 评估 |
|-------|------|
| turn-lock / turn-snapshot 独立模块 | ✓ 不在 orchestrator 内堆 if，可独立测试 |
| signal 进 TurnRequest（非第二参数） | ✓ 补全 Issue 3 故意留的口子，方向正确 |
| 快照放 workspace 外 | ✓ 不污染 workspace 唯一事实来源语义 |
| 失败路径统一（一条） | ✓ timeout/crash/done-missing/output-empty 都走 snapshot restore，不分叉 |
| 锁释放用 try/finally | ✓ 保证异常路径也释放，不留僵尸锁 |
| 回滚 = 整目录恢复（非选择性） | ✓ 避免"恢复了一半"的混合态 |
| listStories 零改动 | ✓ isValidStoryId 已过滤 .snapshots |
| route 层区分 409/500 | ✓ 两种失败语义不同，不混在一个码 |

---

## 待第二意见审查的关键点

1. **AbortSignal.timeout 的 Node 版本要求**——需确认项目 Node 版本 ≥ 18.17（或 Next.js 要求的最低版本）。若不满足，plan 要改用 `setTimeout` 手动 abort。
2. **`Promise.race`（B 方案）的诱惑**——任何 reviewer 都可能提议"用 Promise.race 更简单不就超时了吗"。**必须拒绝**：B 的超时后幽灵写入破坏回滚原子性（Q4 理由1）。这是 Issue 4 最容易踩的坑。
3. **快照整目录拷贝的性能**——workspace 小（MVP 是小场景），整目录拷贝在毫秒级。但真实 agent（Issue 6）可能写大量文件到 workspace，每回合拷贝成本上升。**Issue 4 接受这个成本**（YAGNI：优化是 P1），但 plan 作者要意识到这是已知 trade-off。
4. **restoreSnapshot 覆盖语义**——整目录恢复时，目标 workspace 里 runner 新增的文件（如 actors/新NPC.md）需要被清除。`fs.cp` 默认不删目标多余文件，需先清空目标或用递归 rm + cp。plan 要明确实现，否则回滚不干净。
5. **锁与单进程假设**——当前单 Docker 单 Node 进程，进程内 Map 安全。**若未来多容器/多进程**（P2），此锁失效——届时需外部协调（Redis/DB）。CONTEXT.md 的 Turn Snapshot 术语已隐含"瞬态"语义，锁的"进程内"属性也应记入 plan 的"已知约束"。
6. **signal 放 TurnRequest vs runTurn 第二参数**——选了前者（概念内聚）。但若 reviewer 认为"signal 是运行时控制而非请求数据"，可能倾向后者。**两者功能等价**，记录决策理由（Q4c）即可，非硬约束。
7. **60 秒超时是否够**——Fake Agent 测不出。Issue 6 真实 Claude Code 首次冷启动（模型加载、API 握手）可能 > 60s。但 `TURN_TIMEOUT_MS` env 可覆盖，Issue 6 验收时调整即可。Issue 4 设 60s 默认值合理。
