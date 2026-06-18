# PRD: AI 故事模拟引擎 MVP 技术架构

## Problem Statement

当前项目从 0 开始构建，还没有代码仓库、技术选型、运行方式、部署方式或 issue 切分。产品需求已经明确：要做一个小场景、多角色、主角视角受限的 AI 故事模拟系统。用户只扮演主角，NPC 和世界由系统自主推进，角色有私有记忆、误解、关系和行动倾向，事件结果由因果与真随机共同决定，允许失败、误会和不可逆后果。

但在进入 to-issue 垂直切分前，需要先明确 MVP 的技术架构边界，否则后续 issue 会切得过大、过虚或横跨太多不确定点。

当前需要解决的问题是：

1. 第一版如何提供可玩的 Web 入口。
2. 是否使用传统后端直接调用大模型 API，还是使用 agent 作为运行时核心。
3. 如何让 agent 维护故事状态，同时避免过早建设复杂数据库和事务系统。
4. 如何保证主角视窗输出不直接暴露 agent 执行过程、隐藏状态和内部日志。
5. 如何引入工具真随机，而不是让模型假装随机。
6. 如何在 MVP 中降低部署、认证、并发、失败恢复和运行环境复杂度。
7. 如何保留未来替换 agent runtime、迁移自定义 runner、拆分服务或结构化存储的空间。

## Solution

MVP 采用一个本地 Docker 单容器运行的极简 Web 应用。用户通过浏览器访问 Web 页面，输入主角行动或台词。系统将输入写入当前故事的 Story Workspace，然后通过 Agent Runtime Adapter 冷启动一个现成 CLI agent 执行本回合。agent 读取并修改 Markdown-first 的 Story Workspace，必要时调用随机工具做真随机判定，最后写入固定的主角可见输出。Web 后端只读取固定输出并返回给页面，不直接返回 agent stdout 或内部执行过程。

整体架构：

```text
Browser Web UI
  → Story Turn API
  → Agent Runtime Adapter
  → CLI Agent Runner
  → Story Workspace
  → Fixed Player Response
  → Browser Web UI
```

MVP 技术路线：

- 使用 Next.js / React 作为极简 Web 全栈壳。
- 使用 Docker 单容器运行 Web 服务、Agent Runtime Adapter、CLI Agent Runner、随机工具和 Story Workspace。
- 使用 Agent Runtime Adapter 隔离具体 agent。
- 第一版优先支持 Claude Code Runner；Codex CLI Runner 作为备选。
- 不将业务架构绑定到 Claude Code 或 Codex。
- 后续可替换为 Custom Story Agent Runner、HTTP Agent Service 或 SDK Runner。
- Story Workspace 采用 Markdown-first + 最小系统约定。
- 每个 storyId 对应一个独立 Story Workspace。
- Story Workspace 是唯一事实来源。
- agent 每回合冷启动，不依赖长期会话记忆。
- agent 直接写 Story Workspace，但每回合前创建快照，失败时回滚。
- agent 必须写固定输出文件，Web 后端只读取固定输出文件返回用户。
- agent 不能自己假装随机，必须调用随机工具。
- 随机工具支持“选项 + 概率/权重”输入，并写入随机日志。
- 前端只做 loading，不做 token 级流式输出。
- 同一故事串行执行，不考虑并发回合。
- 凭证通过环境变量传入，不写进镜像、代码、Story Workspace 或日志。

### Requirement Levels

#### P0 / MVP

1. 极简 Web 页面。
2. Next.js / React 全栈壳。
3. Docker 单容器运行。
4. Web 端口暴露给浏览器访问。
5. Agent Runtime Adapter。
6. CLI Agent Runner。
7. Claude Code Runner 优先。
8. Codex CLI Runner 作为备选。
9. Story Workspace 作为唯一事实来源。
10. Markdown-first Story Workspace。
11. 最小系统约定：固定输入、固定输出、运行成功标记、随机日志位置。
12. 多 storyId 最小隔离。
13. 每个 storyId 独立 Story Workspace。
14. 每回合冷启动 agent。
15. agent 直接写 Story Workspace。
16. 每回合执行前创建快照。
17. agent 失败、超时、无固定输出或基础校验失败时回滚。
18. Web 后端只返回固定主角可见输出。
19. 不返回 agent stdout。
20. agent 必须调用随机工具。
21. 随机工具支持候选项 + 权重/概率。
22. 随机结果写入内部随机日志。
23. 前端显示 loading，回合完成后一次性返回。
24. 同一 storyId 串行执行。
25. 不做用户账户。
26. 不做真正流式输出。
27. 不做数据库。
28. 不做复杂自研 agent runtime。
29. 不做双容器拆分。
30. 凭证通过环境变量注入。
31. 镜像不内置任何凭证。
32. 故事初始化由用户自然语言输入 + agent 自动初始化 Story Workspace 完成。
33. Player-visible Turn History 保存到 `turns/history.jsonl`。
34. 刷新页面后展示完整已提交历史。
35. agent 冷启动时读取历史作为上下文，但不能修改历史文件。
36. 历史追加失败视为回合失败并回滚。

#### P1 / Post-MVP

1. 增加 Codex CLI Runner 实现。
2. 引入更干净的 Custom Story Agent Runner。
3. 将 CLI Runner 替换或补充为 HTTP Agent Service Runner。
4. Story Workspace 部分状态结构化。
5. 引入 JSON/JSONL 或数据库作为特定日志和状态的可选存储。
6. 增加更严格的 workspace 校验。
7. 增加可配置 agent runner。
8. 增加 agent 执行超时、重试和失败原因分类。
9. 增加故事列表与基础管理能力。
10. 增加更强的 storyId 运行锁和排队机制。
11. 增加运行指标、耗时统计、token 估算和成本记录。
12. 增加更完善的随机判定审计。
13. 增加更严格的凭证隔离方式，例如独立 agent-auth volume。
14. 增加可插拔模型/agent 配置。
15. 增加 workspace 版本历史和回放能力。

#### P2 / Future

1. 多用户账户系统。
2. 云端部署。
3. 多租户隔离。
4. Web/Agent 双容器拆分。
5. 独立 Agent Service。
6. Kubernetes 或复杂部署编排。
7. 真正 token 级流式输出。
8. 完整数据库化状态存储。
9. 高级调试面板。
10. 作者模式或 GM 模式。
11. God State 可视化。
12. NPC 私有记忆可视化。
13. 随机日志可视化。
14. 大规模并发 story session。
15. 大规模 NPC 模拟。
16. Agent 沙箱和权限系统。
17. 自研完整 agent orchestration framework。
18. LangGraph / OpenAI Agents SDK / Microsoft Agent Framework 等深度集成。
19. SillyTavern 插件集成。
20. 移动端适配或桌面客户端。

## User Stories

1. As a player, I want to open a local web page, so that I can play the story without using a terminal directly.
2. As a player, I want a minimal story UI, so that I can focus on reading and entering protagonist actions.
3. As a player, I want to type protagonist input into a web form, so that I can drive the story from the protagonist perspective.
4. As a player, I want the page to show a loading state while the story turn is running, so that I know the system is processing my input.
5. As a player, I want the story response to appear after the turn finishes, so that I only see the final protagonist-visible output.
6. As a player, I do not want to see agent execution logs, so that hidden information and internal reasoning are not exposed.
7. As a player, I do not want to see raw CLI stdout, so that the story view remains clean and immersive.
8. As a player, I want each story to have its own storyId, so that different stories do not mix state.
9. As a player, I want each story to maintain its own workspace, so that one story’s NPC memory and world state do not affect another story.
10. As a player, I want story data to persist across container restarts, so that my story is not lost when the app restarts.
11. As a player, I want the app to run in Docker, so that setup is simple and predictable.
12. As a player, I want only the web port exposed, so that I can access the app from my browser without managing internal processes.
13. As a developer, I want a single Docker container for MVP, so that setup and debugging remain simple.
14. As a developer, I want Web, agent runner, random tool and story workspace in one container for MVP, so that I avoid premature service splitting.
15. As a developer, I want to avoid mounting broad host directories, so that the agent cannot casually modify unrelated host files.
16. As a developer, I want credentials injected through environment variables, so that secrets are not baked into the image.
17. As a developer, I want the Docker image to contain no API keys or tokens, so that the image can be shared or rebuilt safely.
18. As a developer, I want the app to avoid writing credentials to logs or story files, so that secrets do not leak.
19. As a developer, I want a Next.js / React shell, so that the MVP can provide a Web experience quickly.
20. As a developer, I want the Story Engine logic isolated from React components, so that UI code does not become the story runtime.
21. As a developer, I want an Agent Runtime Adapter, so that the Web layer does not know which agent implementation is used.
22. As a developer, I want a CLI Agent Runner behind the adapter, so that MVP can use existing CLI agents quickly.
23. As a developer, I want Claude Code Runner as the first supported runtime, so that the MVP can use an existing agent that works well with workspace files.
24. As a developer, I want Codex CLI Runner as a future or backup runtime, so that the architecture does not depend on one agent.
25. As a developer, I want the adapter to hide runner details, so that Claude Code, Codex CLI or future custom runners can be swapped without rewriting UI logic.
26. As a developer, I want to avoid building a custom agent runner in MVP, so that we do not overbuild before validating the product loop.
27. As a developer, I want to document that Claude Code Runner is a validation runtime, so that the project does not become permanently coupled to coding-agent assumptions.
28. As a developer, I want the Story Workspace to be the only source of truth, so that agent session memory cannot silently diverge from persisted state.
29. As a developer, I want each turn to cold-start the agent, so that long-running agent context does not pollute story state.
30. As a developer, I want the agent to read the workspace every turn, so that persisted files define the current story.
31. As a developer, I want story state to be Markdown-first, so that coding agents can read and maintain it naturally.
32. As a developer, I want role cards, world state, player knowledge and NPC memory to be human-readable, so that debugging the story is easy.
33. As a developer, I want minimal system conventions, so that MVP does not get blocked by complex schemas.
34. As a developer, I want fixed input and output locations conceptually, so that the Web backend can hand off to the agent and retrieve results consistently.
35. As a developer, I want a fixed player-visible output artifact, so that the frontend only displays content intended for the player.
36. As a developer, I want the agent to write a turn completion marker or equivalent success signal, so that the backend can know whether the turn completed.
37. As a developer, I want the agent to write internal logs separately from player output, so that debugging data does not leak into the story view.
38. As a developer, I want the agent to be allowed to write story workspace files directly in MVP, so that we do not overbuild a patch/commit system.
39. As a developer, I want a workspace snapshot before each turn, so that agent failures do not corrupt the story.
40. As a developer, I want rollback on failure, so that partial agent writes are not preserved after a bad run.
41. As a developer, I want failed turns to return a simple retry message, so that the user can continue without seeing internal errors.
42. As a developer, I want failed turns to log internal error details, so that I can diagnose issues later.
43. As a developer, I want timeout handling around agent execution, so that a stuck agent does not block the app forever.
44. As a developer, I want missing fixed output to count as failure, so that incomplete turns are not shown to the user.
45. As a developer, I want basic output validation, so that obviously invalid agent results are rejected before being shown.
46. As a developer, I want one story turn per storyId at a time, so that concurrent agent runs do not corrupt the same workspace.
47. As a developer, I want story turns to be serial, so that file-based state remains safe.
48. As a developer, I want MVP to ignore complex concurrency, so that the architecture stays small.
49. As a developer, I want different storyIds to be conceptually isolated, so that future multi-story support is easier.
50. As a developer, I want story initialization to be agent-driven, so that users can start from natural language instead of filling rigid templates.
51. As a player, I want to describe a small story premise in natural language, so that I can start quickly.
52. As a player, I want the system to generate the initial Story Workspace, so that setup does not require manual file editing.
53. As a player, I want user-provided role cards to be respected during initialization, so that my explicit character ideas remain canon.
54. As a player, I want the system to fill gaps when my initial setup is incomplete, so that I do not need to define everything up front.
55. As a developer, I want a random tool separate from the agent model, so that randomness is real rather than model-imagined.
56. As a developer, I want the random tool to accept options and probabilities, so that story choices can be weighted by context.
57. As a developer, I want random results logged, so that important story branches can be audited.
58. As a developer, I want the agent to obey random tool results, so that it cannot override inconvenient outcomes.
59. As a player, I want random outcomes to be possible, so that the story does not always follow the most predictable narrative path.
60. As a player, I want bad outcomes to be possible, so that the world does not feel like it is protecting me.
61. As a developer, I want no token streaming in MVP, so that fixed output filtering remains simple.
62. As a developer, I want loading plus final response, so that the UX is acceptable without increasing architecture complexity.
63. As a developer, I want to avoid returning partial generation, so that hidden state is not exposed mid-run.
64. As a developer, I want no database in MVP, so that state remains easy for agent to read and modify.
65. As a developer, I want future database migration to remain possible, so that Markdown-first does not block later structure.
66. As a developer, I want the architecture to support future custom story agent runners, so that coding-agent prompt overhead can be removed later.
67. As a developer, I want current CLI agents treated as replaceable, so that their coding-specific context does not become product architecture.
68. As a developer, I want not to solve cloud deployment in MVP, so that the first version stays local and controllable.
69. As a developer, I want not to solve user login in MVP, so that the first version focuses on the story loop.
70. As a developer, I want not to solve multi-user security in MVP, so that Docker-local execution remains tractable.
71. As a developer, I want not to build a debug UI in MVP, so that hidden state remains internal and engineering scope stays small.
72. As a developer, I want the project to be ready for vertical issue slicing after architecture PRD, so that implementation can proceed in small value increments.
73. As a developer, I want this PRD to define what is P0 and what is not, so that agent implementation does not expand into non-MVP work.
74. As a developer, I want to keep implementation details out of this PRD, so that technical design can be done separately without over-constraining code.
75. As a developer, I want testing seams defined at the architecture level, so that later issues can be tested by behavior rather than internal implementation.
76. As a player, I want to see my committed turn history after page refresh, so that I can continue the story without losing context.
77. As a player, I want each turn in history to show what I input and what the protagonist saw, so that I can review what happened.
78. As a developer, I want turn history stored in `turns/history.jsonl`, so that it is separate from scratch files in `turn/`.
79. As a developer, I want turn history to be append-only, so that past turns cannot be retroactively modified.
80. As a developer, I want the agent runner to read turn history for context but not modify it, so that history remains a stable record.
81. As a developer, I want history append failure to cause turn failure and rollback, so that incomplete history is not preserved.

## Implementation Decisions

1. Build a minimal Web MVP rather than CLI-only interaction.
2. Use Next.js / React as the full-stack Web shell.
3. Keep Story Engine and agent orchestration logic outside React components.
4. Run MVP in a single Docker container.
5. Expose only the Web port to the user.
6. Include Web service, Agent Runtime Adapter, CLI Agent Runner, random tool and Story Workspace in the same container for MVP.
7. Use environment variables for agent/API credentials.
8. Do not bake credentials into the Docker image.
9. Do not write credentials into Story Workspace or logs.
10. Do not mount broad host directories into the container as part of the normal MVP runtime.
11. Do not mount Docker socket into the container.
12. Use Agent Runtime Adapter as the stable boundary between Web/API logic and concrete agent runtimes.
13. Implement a CLI Agent Runner behind the adapter for MVP.
14. Prioritize Claude Code Runner as the first CLI runtime.
15. Keep Codex CLI Runner as a planned alternative runner.
16. Treat Claude Code Runner as an MVP validation runtime, not as the permanent product runtime.
17. Do not depend on long-running Claude Code or Codex session memory.
18. Do not depend on coding-specific behavior from the CLI agent.
19. Preserve future ability to replace CLI Runner with Custom Story Agent Runner, SDK Runner or HTTP Agent Service Runner.
20. Use Markdown-first Story Workspace.
21. Keep only minimal system conventions around input, output, success marker and random log.
22. Avoid JSON/JSONL/database as mandatory P0 state storage.
23. Allow later partial structure for logs or state when needed.
24. Every story has a storyId.
25. Every storyId maps to an isolated Story Workspace.
26. No user account system in MVP.
27. No complex story management in MVP.
28. Story Workspace is the only source of truth.
29. Each story turn cold-starts the agent.
30. Agent reads current state from Story Workspace each turn.
31. Agent directly writes the Story Workspace in MVP.
32. Do not build a patch proposal and system commit pipeline in MVP.
33. Before each story turn, create a workspace snapshot.
34. If the agent run fails, times out, misses fixed output or fails basic validation, rollback to the pre-turn snapshot.
35. Return a simple failure message to the user after rollback.
36. Log internal failure details separately.
37. Web backend must not return agent stdout to the user.
38. Web backend only returns the fixed player-visible output artifact.
39. Internal logs, God State, NPC memory and agent execution details are not player-visible.
40. Use frontend loading state while agent executes.
41. Return final response only after the turn finishes.
42. Do not implement token-level streaming in MVP.
43. Same storyId executes turns serially.
44. Do not support concurrent turns for the same story.
45. Design assumes serial execution only.
46. Randomness must be delegated to a tool, not invented by the agent.
47. Random tool accepts candidate options and weights/probabilities.
48. Random tool writes random result to internal random log.
49. Agent must continue story generation based on the random tool result.
50. Story initialization is performed by an initialization agent flow.
51. User supplies natural-language small scene premise.
52. User may supply protagonist and NPC role cards.
53. System fills missing setup details where needed.
54. User-provided role cards and explicit setup are higher priority than inferred setup.
55. MVP does not support large-world automatic shrinking.
56. MVP assumes the user starts with a small scene.
57. MVP does not include author mode, GM mode or debug state UI.
58. MVP does not include direct database persistence.
59. MVP does not include multi-container service split.
60. MVP does not include cloud multi-tenant deployment.

## Testing Decisions

### Testing Philosophy

Tests should focus on architecture behavior and external contracts, not internal implementation details. The MVP architecture is intentionally simple and file/workspace-based, so tests should verify the behavior of the story turn lifecycle, adapter boundary, workspace safety, random tool integration and player-visible output filtering.

Good tests should answer:

1. Does a user input produce a player-visible response through the full turn pipeline?
2. Does the Web layer avoid returning agent stdout?
3. Does the system read only the fixed player-visible output for display?
4. Does a failed agent run rollback workspace changes?
5. Does the random tool produce and log real random choices?
6. Does the same storyId avoid concurrent execution?
7. Does each storyId stay isolated from other story workspaces?
8. Does story initialization create a playable workspace from natural language input?
9. Does the app run inside Docker with environment-provided credentials?
10. Does the architecture allow runner replacement through the adapter boundary?

### Proposed Test Seams

Because no repository is available in the current conversation, these are proposed architecture seams rather than references to existing code.

#### 1. Full Story Turn Seam

Test the highest-level story turn behavior.

Scope:

- User submits input.
- System writes turn input.
- Agent runner is invoked through the adapter.
- Agent produces fixed output.
- Web returns final player-visible response.

Assertions:

- Response comes from fixed player-visible output.
- Raw agent stdout is not returned.
- Internal logs are not returned.
- The turn completes successfully.

#### 2. Agent Runtime Adapter Seam

Test the adapter contract independently of a real CLI agent.

Scope:

- Use a fake runner or controlled test runner.
- Verify Web/API layer calls adapter rather than concrete CLI implementation.
- Verify adapter returns a normalized result.

Assertions:

- Concrete agent can be swapped in tests.
- Runner details do not leak into Web layer.
- Adapter reports success, failure, timeout and missing output in normalized form.

#### 3. Workspace Isolation Seam

Test storyId-level workspace isolation.

Scope:

- Create two storyIds.
- Run or simulate turns in each.
- Verify state/output/logs remain isolated.

Assertions:

- Story A does not read or write Story B workspace.
- Fixed output for Story A does not appear in Story B.
- storyId is required for turn execution.

#### 4. Snapshot and Rollback Seam

Test failure recovery.

Scope:

- Create initial workspace state.
- Simulate agent partially modifying workspace.
- Simulate failure, timeout, missing output or validation failure.
- Verify rollback.

Assertions:

- Pre-turn state is restored.
- Partial output is not shown.
- Failure is logged internally.
- User receives retry-safe failure response.

#### 5. Fixed Output Filtering Seam

Test player-visible output boundary.

Scope:

- Simulate agent writing multiple files and stdout content.
- Only fixed player-visible output should be returned.

Assertions:

- stdout is ignored for player response.
- internal logs are ignored for player response.
- hidden files are not returned.
- missing fixed output fails the turn.

#### 6. Random Tool Seam

Test random tool behavior.

Scope:

- Provide weighted candidate options.
- Invoke random tool.
- Verify one candidate is selected.
- Verify result is logged.

Assertions:

- Tool, not agent, selects the outcome.
- Candidate weights/probabilities are recorded.
- Result is recorded.
- Agent runner can consume the result.

#### 7. Serial Execution Seam

Test same-story turn locking.

Scope:

- Attempt two turns for the same storyId.
- Verify one proceeds and the other is rejected or waits, according to later technical design.

Assertions:

- Two agent runs do not modify the same workspace simultaneously.
- User receives a clear “story is currently running” style response or equivalent behavior.
- Different storyIds remain conceptually independent.

#### 8. Story Initialization Seam

Test natural-language setup.

Scope:

- User submits small scene premise.
- Initialization agent creates workspace.
- Story can accept first turn after initialization.

Assertions:

- Workspace exists for storyId.
- Required conceptual documents are present.
- Fixed starting response or initial state is usable.
- User-provided role card content is preserved.

#### 9. Docker Runtime Seam

Test container-level MVP behavior.

Scope:

- Run the app in Docker.
- Inject credentials through environment variables.
- Mount or persist story data according to deployment design.
- Access Web port.

Assertions:

- Web app starts.
- No credentials are embedded in image.
- Story data persists as configured.
- Agent runner can be invoked inside container.

#### 10. Runner Replacement Seam

Test future extensibility at architecture level.

Scope:

- Replace real runner with fake runner.
- Optionally add second runner implementation.
- Verify Web/API and workspace lifecycle remain unchanged.

Assertions:

- Adapter boundary is sufficient.
- No UI changes are needed to swap runner.
- No Story Workspace format change is required for runner substitution.

### MVP Test Priority

P0 tests should focus on:

1. Full story turn lifecycle.
2. Fixed output filtering.
3. Snapshot rollback.
4. Random tool.
5. Story workspace isolation.
6. Same story serial execution.
7. Story initialization.
8. Docker runtime smoke test.
9. Adapter fake runner test.

P1 tests can add:

1. Multiple concrete runner implementations.
2. Detailed timeout categories.
3. Workspace validation rules.
4. Structured logs.
5. Cost and runtime metrics.
6. More complete Docker credential scenarios.

## Out of Scope

The following are explicitly out of scope for this technical architecture PRD and MVP:

1. Full technical design.
2. File-by-file implementation plan.
3. Detailed directory naming.
4. Detailed random tool CLI syntax.
5. Detailed Dockerfile.
6. Detailed locking implementation.
7. Detailed timeout implementation.
8. Detailed prompt templates.
9. Detailed Story Workspace document templates.
10. Database schema.
11. User account system.
12. Multi-user permissions.
13. Cloud deployment.
14. Multi-container production architecture.
15. Kubernetes.
16. Advanced sandboxing.
17. Token-level streaming.
18. Direct LLM API orchestration as the main MVP runtime.
19. Custom Story Agent Runner in P0.
20. LangGraph integration in P0.
21. OpenAI Agents SDK integration in P0.
22. Microsoft Agent Framework integration in P0.
23. Hermes/OpenClaw deep integration in P0.
24. SillyTavern plugin integration.
25. Author mode.
26. Debug UI.
27. God State viewer.
28. NPC memory viewer.
29. Random log viewer.
30. Large-scale NPC simulation.
31. Large-world automatic shrinking.
32. Production-grade observability.
33. Billing and token accounting.
34. Mobile app.
35. Desktop app.
36. Issue tracker publishing, because the issue tracker is not available in the current conversation.
37. Codebase-specific ADR alignment, because no repository is available in the current conversation.

## Further Notes

This PRD was synthesized from the current product and architecture discussion. The project is starting from zero and no repository was available to inspect, so repository exploration, existing ADR review, existing test prior art, issue publishing and `ready-for-agent` triage labeling could not be completed here.

The current confirmed architecture direction is:

1. Extreme MVP Web shell, not full product UI.
2. Next.js / React for the Web shell.
3. Docker single-container local-first runtime.
4. Agent Runtime Adapter as the key abstraction.
5. CLI Agent Runner as the first implementation.
6. Claude Code Runner first, Codex CLI Runner as backup.
7. Markdown-first Story Workspace as the source of truth.
8. storyId-based workspace isolation.
9. Per-turn cold-start agent.
10. Agent directly writes workspace in MVP.
11. Snapshot before run, rollback on failure.
12. Fixed player-visible output returned to Web.
13. No raw agent stdout returned.
14. Tool-based weighted random choice.
15. Frontend loading plus final response, no streaming.
16. Serial execution per story.
17. Environment-variable credentials.
18. No database, no account system, no custom runner in P0.

Recommended next step after this PRD:

1. Convert this into a technical architecture issue.
2. Mark it as the architecture baseline for MVP.
3. Then produce vertical implementation issues from P0 only.
4. Keep P1/P2 out of first execution plan unless a P0 decision explicitly requires a seam for future replacement.