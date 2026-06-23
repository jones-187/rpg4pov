下面是基于“产品 PRD + 技术架构 PRD”的 **第一版垂直切分草案**。我按“每个 issue 做完都能 demo / 验证一个端到端行为”来切，没有按模块横切。

## 拟拆分 Issues

### 1. 启动 Docker 化极简 Web 故事壳

**Type**: AFK
**Blocked by**: None - can start immediately
**User stories covered**: 技术架构 PRD US 1-5, 11-19, 61-64
**Status**: 实现 + 评审通过,待 Docker 环境验证
- ✅ 代码实现完成(5 个提交对应 plan 的 5 个 Task)
- ✅ 代码评审通过:静态审查无缺陷,边界守得住(无 storyId/workspace/agent/随机/锁/回滚,均留给后续 issue)
- ✅ Vitest API 契约测试 4/4 全绿(200/echo/空输入 400/坏 JSON 400)
- ⏭️ 待验证:Docker 构建 + 容器内冒烟(`curl /` 返回 200、占位 `POST /api/story-turn` 返回 `playerResponse`、镜像内不含 `src`/`tests`/`docs`/`.git`)——本机无 Docker,需在有 Docker 的环境补跑
- ⏭️ 待验证:浏览器人工冒烟(故事显示区 + 输入框 + 发送按钮 + loading 态)
- ⚠️ 已知:本机 `pnpm build` 因 Windows 符号链接权限(`output:"standalone"` 的 trace 阶段)失败;按约定仅以 Docker 内表现为准,不作为阻塞项

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
**Status**: 实现 + 测试完成
- ✅ 代码实现完成（8 个提交对应 plan 的 8 个 Task）
- ✅ 单元测试全绿：turn-lock（7）/ turn-snapshot（8）/ turn-error-log（4）/ orchestrator（11，含 rollback/timeout/lock）/ route（8）/ workspace（23）/ fake-agent-runner（4）
- ✅ TypeScript 类型检查通过
- ⏭️ 待验证：浏览器人工冒烟（失败回填——Fake Agent 下难触发，由代码审查保证）
- ⏭️ 待验证：Docker 容器内冒烟（与本机无 Docker 同阻塞项，留 Issue 1 验证环境）

**目标行为**：同一个 storyId 同一时间只能执行一个回合。每回合执行前创建快照。Fake Agent 成功时正常返回固定输出；Fake Agent 超时、失败、未生成固定输出或基础校验失败时，系统回滚到回合前状态，并向用户展示可重试的失败提示。

这一片把”agent 直接写 workspace”的风险压住，防止半成品状态污染故事。

------

### 5. 加入工具真随机：roll-choice 端到端验证

**Type**: AFK
**Blocked by**: Issue 3
**User stories covered**: 技术架构 PRD US 55-60
**Status**: 实现 + 测试完成
- ✅ `rollChoice` 工具模块完成：候选项 + 权重、调用方提供 rollId、可注入 rng、生产 crypto 随机
- ✅ 成功随机判定追加写入 `logs/random-rolls.jsonl`（JSONL），Web/API 不返回 random log
- ✅ 集成测试证明随机结果可绑定到 `turn/output.md`
- ✅ 随机工具失败与 random log 写入失败触发 Orchestrator rollback
- ⏭️ 不做 CLI wrapper；Issue 6 接真实 Claude Code Runner 时再基于本模块增加 shell 调用方式

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

### 6.5. 保存并展示 Player-visible Turn History

**Type**: AFK
**Blocked by**: Issue 6
**User stories covered**: 技术架构 PRD US 6-7, 35-39, 61-63, 76-81
**Status**: 实现 + 测试完成
- ✅ 代码实现完成（7 个提交对应 plan 的 7 个 Task）
- ✅ 单元测试全绿：turn-history（9）/ workspace（24，含 history.jsonl 初始化）/ orchestrator（17，含 history append/rollback）/ API（14）/ frontend（验证 turn 结构）
- ✅ TypeScript 类型检查通过
- ✅ Claude prompt 明确读取 `turns/history.jsonl` 并禁止修改

**目标行为**：系统保存玩家可见的回合历史到 `turns/history.jsonl`。刷新页面后能展示完整已提交历史。Claude Code Runner 冷启动时读取历史作为玩家已见/已说的上下文，但不修改历史文件。

这是 MVP 的基础体验：没有它，刷新页面后看不到前文；没有它，Claude Code 冷启动缺少主角已经看见/说过什么的上下文。

**验收标准**：
1. createStory 会创建 `turns/` 和 `turns/history.jsonl`。
2. 成功回合后，TurnOrchestrator append 一条 history entry。
3. history entry 包含 turnId / at / input / output。
4. history append 失败会导致本回合失败并 rollback。
5. 失败/timeout/rollback 回合不会留下 history entry。
6. GET /api/stories/{storyId} 返回 story meta + history。
7. 故事页刷新后能展示完整 committed history。
8. POST /api/story-turn 成功返回 { playerResponse, turn }。
9. 前端提交成功后 append 后端返回的 committed turn。
10. Claude Runner prompt 明确读取 `turns/history.jsonl`。
11. prompt 明确禁止 runner 修改 `turns/history.jsonl`。

------

### 7. 用自然语言初始化视觉小说式 Story Workspace

**Type**: AFK
**Blocked by**: Issue 6.5
**User stories covered**: 技术架构 PRD US 50-54, 82-83；产品 PRD US 98-100, 105-107, 123

**目标行为**：用户输入一个小场景故事设定，初始化 agent 基于该设定生成可玩的 Story Workspace。初始化结果不仅包含世界设定、基础规则、初始状态和开场主角视窗，还必须提供后续叙事智能所需的主角与角色材料，并将开场内容写入统一的玩家可见历史。

**范围**：

1. 初始化 Protagonist Core。
2. 初始化第一人称叙述基调。
3. 初始化心理描写偏好。
4. 初始化基础 agency boundaries。
5. 初始化主要角色的 voice 和基本动机。
6. 初始化支撑 Meaningful Change 所需的基础矛盾、秘密或压力源。
7. 保留用户提供的明确角色卡和故事设定，作为高优先级 canon。
8. 初始化开场玩家可见内容。
9. 将 opening 写入统一玩家可见历史（作为 opening entry，不伪造"开始故事"玩家输入）。
10. 生成后续 Narrative Turn 可以消费的初始材料。

**非目标**：

1. 不实现长期玩家行为推断。
2. 不实现显式反馈学习。
3. 不实现完整 Adaptive Authored Protagonist 逻辑。
4. 不实现 Decision Point UI。
5. 不生成建议选项。
6. 不实现完整 Narrative Turn Contract。
7. 不拆分多 Agent。
8. 不引入固定剧情路线、固定章节或固定结局。
9. 不实现 Confirmed Adjustments 反馈 UI。
10. 不实现 Inferred Tendencies 学习。

**验收标准**：

1. 用户不需要手动编辑文件即可从自然语言设定得到可玩的 Story Workspace。
2. 初始化后的 workspace 包含可支撑第一人称心理描写的 Protagonist Core，而不是空白玩家占位符。
3. Protagonist Core 至少覆盖 narrativeVoice、temperament、emotionalExpression、conflictStyle、relationshipStyle、humorStyle、initiative、moralBoundaries、speechPatterns、avoidExpressions。
4. 初始化结果明确基础 agency boundaries：哪些低风险表现可以自动演出，哪些重大决定必须交还玩家。
5. 初始化结果包含主角心理描写偏好和第一人称叙述基调。
6. 主要 NPC 至少有 voice、基本动机和初始关系/压力材料。
7. 初始世界包含足以支撑后续 Meaningful Change 的矛盾、秘密、风险或压力源。
8. 用户提供的明确角色卡内容优先保留，不被系统随意重写。
9. 初始化不写入长期玩家推断、显式反馈学习结果或建议选项状态。
10. 初始化不预写完整剧本、固定章节大纲、固定角色路线或固定结局。
11. 开场主角视窗作为 opening entry 写入玩家可见历史，刷新后可恢复。
12. 不得伪造"开始故事"玩家输入。

完成后，用户不需要手动编辑文件就能开始一个带有主角声音、角色 voice 和基础戏剧压力的故事。

------

### 8. Narrative Turn Contract：有效变化、角色意图与视觉小说式表演

**Type**: HITL
**Blocked by**: Issue 4, Issue 6, Issue 6.5, Issue 7
**User stories covered**: 技术架构 PRD US 84-86；产品 PRD US 105, 112-116, 123-124

**目标行为**：每个正常 Story Turn 在生成正文前先判断本回合为什么值得发生、结束后什么发生了变化、相关 NPC 正在追求什么，并把结果渲染为第一人称、主角限知、偏 galgame/视觉小说式的玩家可见输出。

**主要解决**：

1. 故事不推进。
2. NPC 过于被动。
3. 文本僵硬。
4. 只有环境细节，没有人物或情节变化。
5. 每回合都停在无意义的空输入点。

**范围**：

1. Meaningful Change（有效变化）。
2. NPC Character Intent（角色意图）。
3. galgame/视觉小说式 Performance（表演与呈现）。
4. 避免平级细化。
5. NPC 主动行动。
6. 每个回合先确定发生什么变化，再生成正文。
7. 第一人称叙事的基础要求。
8. 回合结尾在叙事语义上形成连续演出或可回应状态，正式交互结构留给 Issue 10。

**不包括**（由 Issue 10 Decision Points & Input Guidance 负责）：

1. 正式的 `continue | decision` 数据结构。
2. Suggestion Gate。
3. UI 建议。
4. "继续"命令。
5. interaction state API 和持久化。
6. 刷新恢复交互状态。

**Meaningful Change 详细要求**：

每个正常回合结束后，至少产生一个玩家能够感知的有效变化。

有效变化可以包括：
- 获得新的信息。
- 人物关系发生变化。
- 角色作出决定、承诺、拒绝、撒谎或改变立场。
- 玩家目标取得进展或受到阻碍。
- 风险升级、暴露、缓解或解除。
- 时间、地点或场景发生变化。
- 角色暴露新的性格侧面。
- 玩家对角色的理解发生变化。
- 角色产生新的目标或放弃旧目标。
- 当前冲突进入新的阶段。

以下内容单独出现时，不算有效变化：
- 复述或扩写玩家输入。
- 单纯增加环境描写。
- 对同一物体继续补充平级细节。
- 延续原有情绪，但没有新的行为或关系变化。
- 用更多文字表达与上一回合相同的信息。
- 角色继续维持原态度并等待玩家推动。
- 单纯写得更长或更华丽。
- 为了制造氛围而重复身体、光线、天气等无信息量细节。

日常、闲聊、暧昧和慢节奏场景可以存在，但必须至少推动：人物关系、角色理解、情绪位置、信任或误解、后续冲突的条件。慢不等于不推进。

**Character Intent 详细要求**：

每个回合生成前，应考虑重要角色当前的最小动态状态：
- `currentEmotion`：角色此刻的主要情绪。
- `immediateGoal`：角色当前想从玩家、其他角色或当前场景中得到什么。
- `hiddenIntent`：角色不愿直接说出的真实目的、需求、担忧或试探。
- `voice`：角色具体如何说话，包括表达习惯、直接程度、回避方式、幽默方式和禁止使用的通用表达。

角色可以主动：发起对话、提问、试探、回避、撒谎、打断、改变话题、离开、靠近、隐瞒、暴露脆弱、采取与玩家目标不同的行动。

角色不能只负责：回答玩家问题、提供剧情说明、顺从玩家要求、等待玩家继续推进。

**Performance 详细要求**：

人物情绪应优先通过以下方式表现：
- 对话中的潜台词。
- 反问、回避、打断、停顿和答非所问。
- 与台词含义产生张力的动作。
- 角色独有的语言习惯。
- 角色主动选择做或不做某件事。
- 对过去细节的回调。
- 言语与真实意图之间的差异。
- 对同一事件的不同理解。

避免：
- 直接解释 NPC 的全部心理。
- 所有角色使用相似的成熟、礼貌、理性表达。
- "我理解你的感受""我们应该坦诚面对"等通用 AI 台词。
- 每句话都附加眼神、嘴唇、手指、呼吸等模板动作。
- 为了显得细腻而堆叠无信息量的环境和身体描写。
- 长篇抽象总结人与人之间的关系、信任和人生。
- 只写得更长、更华丽，却没有实际变化。
- 所有角色都围绕玩家服务，缺少自己的目标和立场。

**非目标**：

1. 不实现长期玩家拟合。
2. 不实现完整主角人格学习。
3. 不实现正式 continue/decision 数据结构、Suggestion Gate 或交互状态 API。
4. 不拆分多 Agent。
5. 不引入固定剧本、固定路线或固定结局。
6. 不做性能优化。
7. 不直接修改 Claude Runner 行为作为本 issue 的目标。
8. 不实现"继续"系统命令——这是 Issue 10 的职责。

**依赖原因**：

Issue 4 提供 workspace 快照、回滚和事务安全边界；Issue 6 提供真实 Runner；Issue 6.5 提供 Turn History；Issue 7 提供 Protagonist Core、NPC voice/动机和初始冲突材料。没有这些材料，回合契约只能变成通用写作提示。

**验收标准**：

1. 正常回合必须产生至少一个玩家可感知的有效变化。
2. 纯复述、平级细化和无意义环境扩写不能单独算作推进。
3. 日常慢场景可以存在，但需要推进人物关系、角色理解或情绪位置。
4. 重要 NPC 每回合应具有即时目标，不能只被动回答。
5. 重要 NPC 的输出应考虑当前情绪、即时目标、隐藏意图和独立 voice。
6. 角色可以主动发起对话、行动、回避、试探或打断。
7. 玩家可见输出优先通过潜台词、动作和具体选择表现情绪。
8. 不得因为增强文笔而泄漏 NPC 私密状态。
9. 保持现有主角视窗隔离、workspace 持久化和回合事务规则。
10. 本 Issue 不实现固定剧本、多 Agent、复杂 Beat 或性能优化。
11. 有效变化和非有效变化有明确的文档化判据，不依赖主观感受。
12. Character Intent 至少包含 currentEmotion、immediateGoal、hiddenIntent 和 voice。
13. Performance 优先通过潜台词和具体行为表现情绪，而非直接解释心理。

------

### 9. Adaptive Authored Protagonist Runtime：主角声音、心理描写与控制权边界

**Type**: HITL
**Blocked by**: Issue 7, Issue 8
**User stories covered**: 技术架构 PRD US 87；产品 PRD US 106-107, 109, 123

**目标行为**：主角拥有稳定、可识别的第一人称叙述声音。系统能自动生成符合主角人格的心理活动、低风险台词和自然反应，同时把重大关系、道德、承诺、原谅、信任和不可逆决定保留给玩家。本 issue 是 Adaptive Authored Protagonist 的运行时切片，Issue 9.5 负责同一能力下的反馈、长期偏好和推测倾向切片。

**主要解决**：

1. 主角心理描写冷淡。
2. 主角没有稳定叙述声音。
3. 主角替玩家作出不符合意愿的重大选择。
4. 系统过于保守，主角像摄像头。
5. 系统过于激进，主角频繁背叛玩家意愿。

**范围**：

1. Protagonist Core（基础男主骨架）的使用。
2. 第一人称心理描写（Inner Monologue Guideline）。
3. 主角控制权边界（Protagonist Control Boundary）。
4. 低风险自动反应与重大决定的边界。
5. 玩家本回合输入覆盖系统自动表现。
6. 读取已有 Confirmed Adjustments 和 Inferred Tendencies，并按优先级使用；这些状态的创建和长期更新由 Issue 9.5 负责。

**主角控制权边界详细要求**：

系统可以自动处理：
- 玩家已明确行动的执行细节。
- 不改变立场的自然接话。
- 日常寒暄。
- 符合男主人格的小动作和习惯。
- 当下感知和心理活动。
- 不会关闭重要选择的低风险主动行为。
- 长时间僵持时，符合人物性格的轻度主动推进。
- 已能从玩家输入和稳定人格可靠推出的自然反应。
- 不构成重大承诺的过渡性台词。

系统不得自行增加：
- 玩家没有表达的新目标。
- 重大承诺。
- 关键关系决定。
- 道德越界行为。
- 与玩家当前输入冲突的台词。
- 会关闭其他重要选择的决定。
- 爱、恨、原谅、决裂等关系定案。
- 明显改变路线的不可逆行动。

**心理描写详细要求**：

系统应积极生成：
- 注意力变化、当下联想、记忆触发。
- 瞬间情绪、内心吐槽、疑问和猜测。
- 犹豫、尚未完成的冲动。
- 符合主角基础人格的明确情绪表达。
- 对角色行为和异常细节的即时理解。
- 与当前刺激紧密相关的内心独白。

心理描写不能长期停留在：
- "说不上来的感觉"。
- "心里有些复杂"。
- "一种莫名的情绪"。
- 极度模糊和中性的表达。

系统可以描写完整的心理过程，但以下内容必须交还玩家：
- 爱上或不再爱某人。
- 原谅或不原谅。
- 是否信任某人。
- 告白、承诺、拒绝。
- 关系定义、道德定案。
- 报复、背叛等重大立场。
- 不可逆行为。

**非目标**：

1. 不改变 Issue 7 的职责；Issue 7 只创建初始男主骨架。
2. 不实现固定主角路线。
3. 不让系统替玩家决定爱恨、原谅、信任、承诺、关系定义或不可逆行动。
4. 不实现好感度数值玩法。
5. 不实现复杂情绪数值系统。
6. 不实现长期玩家行为推断的创建或更新（evidence/confidence 学习属于 Issue 9.5）。
7. 不实现显式反馈入口与长期偏好持久化（属于 Issue 9.5）。
8. 不实现 Decision Point UI 或建议选项。
9. 不做性能优化。

**依赖原因**：

Issue 7 提供初始 Protagonist Core；Issue 8 让 Story Turn 能读取并使用主角人格、有效变化和角色意图。本 issue 在此基础上补充运行时控制权边界和心理描写规则。

**验收标准**：

1. 主角具有稳定的第一人称叙述声音。
2. 系统能够生成较充分的内心独白，而不是只有客观事件日志。
3. 系统能够自动生成符合主角人格的低风险台词和自然反应。
4. 系统不得替玩家作出重大关系、道德和不可逆决定。
5. 玩家本回合明确输入必须覆盖基础人格、已确认长期修正和历史推测。
6. 心理描写可以明确而有情绪，但关键心理结论仍交给玩家。
7. 系统可自动处理的行为和不允许自行增加的行为有明确的文档化边界。
8. 心理描写不应长期停留在模糊中性表达，应有明确的主角声音。

------

### 9.5. Adaptive Protagonist Feedback & Adaptation：显式反馈、长期偏好与推测倾向

**Type**: HITL
**Blocked by**: Issue 9
**User stories covered**: 技术架构 PRD US 88-89；产品 PRD US 108, 110-111

**目标行为**：玩家可以纠正主角表现，系统区分本次纠正与长期偏好，根据多次玩家行为逐渐形成 Inferred Tendencies，但不能由单次行为过拟合，也不能偷偷把推测升级为确定人格。本 issue 是 Adaptive Authored Protagonist 的适应切片，与 Issue 9 共同覆盖完整主角模型。

**主要解决**：

1. 男主人格无法随玩家逐渐调整。
2. 系统无法区分临时反应与稳定偏好。
3. 单次行为被永久定型。
4. 显式反馈无法持久生效。

**范围**：

1. 本次纠正（只影响当前生成，不改变长期模型）。
2. 长期偏好（写入 Confirmed Adjustments）。
3. Confirmed Adjustments（玩家确认修正）。
4. Inferred Tendencies（推测倾向，含 evidence 和 confidence）。
5. 防止单次行为过拟合。
6. 明确反馈优先级：玩家本回合输入 → Confirmed Adjustments → Protagonist Core → 高置信 Inferred Tendencies → 低置信 Inferred Tendencies → 系统默认。
7. 区分临时反应、角色关系倾向和稳定人格倾向。

**显式反馈详细要求**：

系统应支持玩家纠正机制，例如：
- "这不像我"
- "心理描写太冷淡"
- "心理描写太多"
- "我不会这么生气"
- "我没有喜欢她"
- "不要把关心解释成爱情"
- "语气应该更克制"
- "以后不要替我作这种承诺"
- "男主可以更主动一些"
- "这次只需要重新生成，不要长期记录"

必须区分：
- **本次纠正**：只修正当前生成，不改变长期主角模型。
- **长期偏好**：写入 Confirmed Adjustments，影响后续所有生成。

显式反馈应高于系统根据行为作出的推测。系统不应偷偷把推测升级为确定人格。

**非目标**：

1. 不改变 Issue 9 的运行时行为规则。
2. 不实现完整反馈 UI（本 issue 聚焦反馈机制和状态持久化）。
3. 不实现好感度数值玩法。
4. 不实现复杂情绪数值系统。
5. 不实现 Decision Point UI 或建议选项。
6. 不做性能优化。

**MVP 定位**：

本 issue 属于当前 P0 叙事体验的一部分，但被拆出为独立切片，避免把主角运行时、反馈入口、长期偏好和推测倾向挤进一个过大的 Issue。若只需要验证基础主角声音，可以先完成 Issue 9；若要验收完整 Adaptive Authored Protagonist，则 Issue 9.5 必须在 Issue 11 前完成。

**依赖原因**：

Issue 9 提供主角运行时的稳定行为规则和控制权边界。本 issue 在此基础上增加长期修正、推测倾向和反馈持久化。

**验收标准**：

1. 显式长期修正高于基础人格和推测倾向。
2. 推测倾向必须包含证据和置信度，必要时包含 caution。
3. 单次行为不得自动升级为稳定人格。
4. 玩家能够区分本次纠正与长期偏好。
5. Confirmed Adjustments 和 Inferred Tendencies 在 workspace 状态中可区分。
6. 反馈优先级明确：玩家本回合明确输入 → Confirmed Adjustments → Protagonist Core → 高置信 Inferred Tendencies → 低置信 Inferred Tendencies → 系统默认。
7. 系统能够区分稳定人格倾向、针对某个角色的关系倾向、特定情境下的临时反应和偶发行为。
8. 推测倾向不得直接决定爱恨、道德底线、原谅、承诺、关系定义或重大选择。
9. 本次纠正和长期偏好在玩家可理解的交互语义上可区分。

------

### 10. Decision Points & Input Guidance：连续演出、决策点与建议门槛

**Type**: HITL
**Blocked by**: Issue 8, Issue 9
**User stories covered**: 技术架构 PRD US 90-91；产品 PRD US 117-122

**目标行为**：当事件尚未到达真正需要玩家决定的位置时，系统可以连续演出；当关系、风险、承诺、信任、公开信息或不可逆后果需要玩家判断时，系统停在明确可回应的 Decision Point。建议选项只作为决策点辅助，不取代自由输入。

**主要解决**：

1. 每一小段文本后都要求玩家输入。
2. 玩家面对空输入框不知道做什么。
3. 建议为了建议而建议。
4. 选项导致剧情横向扩张。
5. 故事无法自然连续演出。
6. 系统替玩家作出本应属于玩家的关键选择。

**范围**：

1. Continuous Performance（连续演出）。
2. Decision Point（决策点）判定。
3. “继续”系统控制。
4. Suggestion Gate（建议选项门槛）。
5. 0 到 4 个建议。
6. 建议填入但不自动提交。
7. 自由输入始终存在。
8. 建议必须服务当前戏剧问题，而不是横向拓展。
9. 正式 `continue | decision` 数据结构（Turn Interaction）。
10. interaction state API 和持久化（`turn/interaction.json`）。
11. 刷新后恢复当前 continue/decision 状态和建议。
12. interaction state 缺失、格式错误和不合法建议的降级处理。

**Continuous Performance 详细要求**：

当前系统不应在每一小段文本后都强制玩家输入。当事件尚未到达真正需要玩家决定的位置时，应进入连续演出状态。

连续演出阶段：
- 系统可以继续进行 NPC 对话。
- 系统可以继续男主心理活动。
- 系统可以生成符合人格的低风险自然反应。
- 系统可以让事件继续发展。
- UI 可以提供”继续”。
- 玩家仍可自由输入进行打断。
- 不强制生成建议选项。

“继续”属于系统级控制，不是主角在故事中的台词或行动。”继续”的含义是：让当前人物和事件自然发展，直到产生下一次有效变化或真正需要玩家决定的位置。

连续演出不能变成无意义地无限扩写。每次继续仍需产生有效变化，或推进至明确决策点。

**Decision Point 详细要求**：

只有在以下情况才主动把关键控制权交还玩家：
- NPC 明确提出需要回答的问题。
- 关系即将发生重要变化。
- 出现需要处理的风险或障碍。
- 玩家需要决定是否公开信息。
- 冲突可以升级、缓和或结束。
- 涉及承诺、拒绝、信任、原谅或关系方向。
- 存在两个以上都合理、但系统不应替玩家判断的方向。
- 下一步会关闭其他重要选择。
- 下一步可能造成不可逆后果。

输出应停在明确的可回应状态。避免停在：
- 纯环境描写。
- 模糊感慨。
- 没有行动对象的沉思。
- 没有任何剧情压力的段落结尾。
- “接下来会发生什么”。
- 只是要求玩家机械输入”继续”。

决策点应让玩家能够理解：当前真正的问题是什么、哪些立场或行动方向正在等待决定、为什么这个决定重要。

**Suggestion Gate 详细要求**：

建议是 Decision Point 的交互辅助，不是剧情推进机制。建议不得每回合强制生成，也不得为了凑数量而生成。

允许：
- 0 个建议：当前处于连续演出阶段。
- 2 个建议：只有两个明显合理方向。
- 3 个建议：常见情况。
- 4 个建议：确实存在四种不同态度。

不固定要求每次四个。所有建议应回应同一个当前戏剧问题。

建议必须满足：
- 至少一个建议能够明确推进当前冲突。
- 不同建议代表不同态度或处理方式。
- 至少有一个相对中性的选择。
- 建议符合已经形成的男主人格。
- 建议不能突然提供完全不符合当前主角的极端行为。
- 建议不能为了制造自由度而横向开启无关内容。
- 建议应优先改变信息、关系、目标、风险或场景状态。
- 点击建议只填入输入框。
- 允许玩家继续修改。
- 不自动提交。
- 始终保留自由输入。

如果无法生成有意义的建议，应改善场景结尾和有效变化，而不是提供”继续观察””继续思考””再看一遍””等待更多信息”等无推进作用的选项。建议选项不是用来掩盖缺乏剧情推进的问题。

**非目标**：

1. 不实现固定选项树。
2. 不把建议选项变成剧情推进机制。
3. 不强制每回合生成建议。
4. 不为了凑数量生成四个建议。
5. 不通过建议绕过玩家关键决定。
6. 不实现完整 VN 对话块协议。
7. 不做性能优化或 token streaming。

**依赖原因**：

Issue 8 需要先让回合能产生有效变化和可回应状态；Issue 9 至少提供基础主角人格与自动演出边界。Issue 9.5 的长期偏好和推测倾向可进一步改善建议语气，但不是 Decision Point 结构本身的前置条件。否则“继续”和建议只会掩盖场景没有推进，或生成不符合主角的横向选项。

**验收标准**：

1. 没有真正决策点时，不强制玩家输入新的角色行动。
2. 连续演出阶段可以通过”继续”推进。
3. 每次”继续”仍需产生有效变化或推进至决策点。
4. 只有真正决策点才生成建议。
5. 建议数量允许为 0 到 4 个，不固定凑数。
6. 建议必须回应同一个当前戏剧问题。
7. 至少一个建议能够明确推进当前冲突。
8. 建议不能仅提供平级观察和无关支线。
9. 建议应符合当前主角人格。
10. 点击建议只填入输入框，不自动提交。
11. 玩家始终可以自由输入。
12. 决策点不能停在纯环境描写或模糊感慨上。
13. 决策点应让玩家理解当前真正的问题、等待决定的方向和为什么重要。
14. “继续”是系统级控制，不是主角台词或故事内行动。
15. 无法生成有意义建议时，应改善场景结尾，不提供”继续观察”等无推进选项。
16. 连续演出阶段不强制生成建议选项。

------

### 11. 打通最小真实可玩链路：创建故事 → 初始化 → 叙事回合 → 决策/继续

**Type**: HITL
**Blocked by**: Issue 5, Issue 6.5, Issue 7, Issue 8, Issue 9, Issue 9.5, Issue 10, Issue 12
**User stories covered**: 技术架构 PRD US 1-7, 50-60, 61-67, 72-91；产品 PRD 中主角视窗、NPC 私有记忆、随机、失败后果、第一人称主角、有效变化、连续演出、决策点和建议门槛相关 MVP 用户故事

**目标行为**：用户从 Web 页面输入小场景设定，系统创建 storyId，初始化 Story Workspace，然后用户输入主角第一回合行动。真实 CLI agent 读取 workspace、必要时调用随机工具、更新故事文件、写入固定 player response，Web 页面展示第一人称、主角限知、角色驱动的可玩文本；回合结尾要么自然进入连续演出，要么停在明确 Decision Point。

这是 MVP 的第一条完整可玩 tracer bullet。标为 HITL，因为需要人工体验判断：故事是否能玩、主角视窗是否成立、有效变化是否可感知、主角声音是否稳定、关键选择是否交还玩家、Claude Code Runner 是否没有明显跑偏。

**非目标**：

1. 不把本 issue 扩展成性能优化。
2. 不引入固定剧本、固定路线或固定结局。
3. 不引入多 Agent。
4. 不改造完整结构化输出协议。
5. 不解决所有后续产品质量问题，只验收第一条真实可玩链路。

**验收标准**：

1. 用户可以从自然语言设定创建故事并进入故事页。
2. 初始化 workspace 可被真实 Runner 用于第一个回合。
3. 第一个真实回合能读取 Turn History 和初始化材料。
4. 第一个真实回合遵守主角视窗隔离。
5. 第一个真实回合至少产生一个有效变化。
6. 重要 NPC 表现出自己的 voice 和即时目标。
7. 主角输出有第一人称叙述声音和必要内心独白。
8. 主角模型能区分 Protagonist Core、Confirmed Adjustments 和 Inferred Tendencies。
9. 重大关系或不可逆决定不被系统擅自代替玩家作出。
10. 回合结尾能区分连续演出和 Decision Point。
11. 玩家仍能自由输入。
12. 随机判定仍通过 Random Tool 而不是模型假装随机。
13. 失败仍走现有 rollback 和错误日志边界。

------

### 12. 强化主角视窗输出隔离与内部日志不外泄

**Type**: AFK
**Blocked by**: Issue 4, Issue 9, Issue 9.5, Issue 10
**User stories covered**: 技术架构 PRD US 6-7, 35-39, 61-63；产品 PRD 中 God State / NPC Memory / Random Log / NPC hiddenIntent / Inferred Tendencies / interaction metadata 不对用户可见的故事

**目标行为**：系统明确验证页面只展示固定 player response 和受控的 interaction state。即使 agent stdout、内部日志、God State、NPC Memory、random log、Narrative Turn Contract 内部判断、NPC hiddenIntent、主角推测倾向或 interaction metadata 中存在内容，也不会被 Web 返回给用户。固定输出缺失或格式明显不合规时，回合失败并回滚。

这个 issue 和 Issue 4 有关联，但更聚焦”主角视窗隔离”的产品风险。新叙事能力引入更丰富的内部角色意图、主角推测倾向和交互元数据后，本 issue 必须覆盖这些内部状态不外泄。

**依赖原因**：

Issue 9 引入了 Authored Protagonist Runtime 和主角控制权边界；Issue 9.5 引入 Confirmed Adjustments、Inferred Tendencies 和反馈状态；Issue 10 引入 Turn Interaction。上述内部状态和受控交互状态都需要纳入输出隔离验收。Issue 12 至少需要 Issue 9、9.5 和 10 完成后才能完整验证新的内部状态不外泄。

**非目标**：

1. 不实现 Narrative Turn Contract 本身。
2. 不实现 Authored Protagonist Runtime 本身。
3. 不实现 Decision Point UI 或建议选项。
4. 不暴露 God State、NPC Memory、random log、内部叙事判断、hiddenIntent、Inferred Tendencies 或 interaction metadata 给普通玩家。

------

## 推荐第一轮执行范围

第一轮 MVP 路线保持从基础架构到真实可玩链路的顺序，但在原 Issue 9 处拆分为运行时和反馈两个 Issue。这样既覆盖完整 Adaptive Authored Protagonist，又避免一个 Issue 同时承担主角表演、控制权、反馈、长期偏好和推测学习。

```text
Issue 1
Issue 2
Issue 3
Issue 4
Issue 5
Issue 6
Issue 6.5
Issue 7
Issue 8
Issue 9      ← Adaptive Authored Protagonist Runtime（MVP 必需）
Issue 9.5    ← Adaptive Protagonist Feedback & Adaptation（MVP 必需，完整 AAP 验收的一部分）
Issue 10
Issue 12     ← 依赖 Issue 9/9.5/10
Issue 11     ← 依赖 7/8/9/9.5/10/12
```

## 依赖关系简图

```text
1. Docker Web 壳
   ↓
2. storyId + Workspace
   ↓
3. Fake Agent 单回合
   ↓
4. 安全执行边界 ───────────────→ 12. 输出隔离强化（≥ Issue 9/9.5/10）
   ↓          ↘
6. Claude Runner   5. 随机工具
   ↓              ↘
6.5. Player-visible Turn History
   ↓
7. 故事初始化：Protagonist Core + NPC voice + 初始压力源 + Opening Entry
   ↓
8. Narrative Turn Contract（叙事质量，不含交互状态 API）
   ↓
9. Adaptive Authored Protagonist Runtime（主角运行时）
   ↓
9.5. Feedback & Adaptation（显式反馈 + 长期偏好 + 推测倾向）
   ↓                ↘
10. Decision Points & Input Guidance（交互控制 + Turn Interaction）
   ↓
12. 输出隔离强化（≥ Issue 9/9.5/10）
                     ↓
                  11. 最小真实可玩链路（≥ 7/8/9/9.5/10/12）
```

`12. 输出隔离强化` 至少依赖 Issue 4、Issue 9、Issue 9.5 和 Issue 10，必须在 Issue 11 之前完成。
`9.5. Adaptive Protagonist Feedback & Adaptation` 属于完整 Adaptive Authored Protagonist 验收的一部分，因其依赖 Issue 9，可在 Issue 10 之前完成，也可与 Issue 10 并行收敛，但不能晚于 Issue 11。
`6.5. Player-visible Turn History` 依赖 Issue 6，必须在 Issue 7 之前（初始化 agent 和后续叙事回合都需要读取历史）。
Issue 7 的 opening entry 通过受信任的系统提交者（Initializer）写入，不需要伪造玩家输入。
Issue 10 负责 Turn Interaction 数据结构和交互状态 API，Issue 8 的叙事契约只负责叙事质量。
原则：**完整可玩验收不能早于隐私与输出隔离验收。**
