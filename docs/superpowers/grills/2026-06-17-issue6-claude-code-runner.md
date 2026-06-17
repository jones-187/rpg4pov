# Issue 6 Grill 结果：接入 Claude Code CLI Runner 作为首个真实 Agent Runtime

> **日期**: 2026-06-17
> **作者**: zhangxiaofa
> **状态**: 默认决策已锁定，未留开放裁决
> **Grill 范围**: ClaudeCodeRunner 实现、CLI 安装与容器集成、凭证注入与防泄漏、子进程调用与权限模式、Random Tool CLI Wrapper、首版 agent prompt、Runner 切换策略、测试策略、超时调整、失败模式边界
> **CONTEXT.md 变更**: 新增 Claude Code Runner、Runner 切换、Random Tool CLI Wrapper 术语与关系
> **HITL 性质**: 实现可交给 agent，但 Docker 环境、凭证注入、CLI 容器内可用性、prompt 稳定性需人工验收

---

## 议题背景

Issue 6 的目标行为（来自 `docs/issue.md`）：

> Agent Runtime Adapter 增加 Claude Code CLI Runner。Web 层仍只依赖 Adapter，不直接感知 Claude Code。用户输入后，系统冷启动 Claude Code Runner，让它在当前 storyId 的 Story Workspace 内完成一个回合，并写入固定主角可见输出。

Issue 6 标为 HITL 的原因：需要人工确认本地 Docker 环境、凭证注入方式、Claude Code CLI 在容器内的实际可用性、首版 agent prompt 是否足够稳定。

Issue 6 不解决故事初始化（Issue 7）、最小真实可玩链路（Issue 8）、输出隔离强化（Issue 9）。

---

## 已锁定基线

现有文档和代码已经给出以下边界：

- **AgentRunner 接口**（`src/lib/agent-runner.ts`）：`runTurn(req: TurnRequest): Promise<TurnResult>`，`TurnRequest` 含 `storyId/workspaceDir/playerInput/signal`，`TurnResult` 含 `success/error?`。
- **Runner 契约**：在 `workspaceDir` 内写 `turn/output.md` + `turn/done.json`，返回 `{success:true}`。内容不通过返回值传递。
- **signal 强制 contract**：runner 必须把 signal 传到子进程层，abort 后停止执行；**不接受 Promise.race-only 超时**（timeout 后幽灵写入破坏回滚原子性）。
- **Turn Orchestrator**（`src/lib/turn-orchestrator.ts`）以磁盘 `done.json` 为权威，不信任 runner 返回值。失败路径（缺 done/缺 output/异常/超时）统一 rollback 整目录快照。
- **route.ts** 模块级单例 `new TurnOrchestrator(new FakeAgentRunner())`。
- **Dockerfile**：`node:20-alpine`，runner stage 用 `nextjs:1001` 非 root 用户，`WORKSPACE_ROOT=/app/data/workspaces`。
- **docker-compose.yml**：仅 `rpg4pov-data` volume 挂载到 `/app/data`，无凭证环境变量。
- **Issue 5 grill Q2 留口**：Issue 6 接真实 Claude Code Runner 时需基于 `random-tool.ts` 增加 CLI wrapper 或等价调用方式。
- **arch-prd**：凭证通过环境变量注入，不写进镜像/代码/Story Workspace/日志；Claude Code Runner 是 MVP validation runtime，非永久产品运行时。

---

## 决策记录

### Q1: Issue 6 验收边界怎么定？

**选择**: **管道接通 + 契约守住**，不追求故事质量。

**理由**:
- Issue 7 专门做故事初始化，Issue 8 做最小真实可玩链路。Issue 6 若追求"有意义故事输出"会吞掉 Issue 7。
- 当前 `createStory` 只写占位文件（`world.md`/`player.md`/`rules.md` 全是占位），Issue 6 验收时 workspace 用占位内容即可。
- Issue 6 的价值是证明真实 CLI agent 能接进 Adapter 边界、契约能守住、凭证不泄漏、失败能回滚。

**验收范围**:
1. ClaudeCodeRunner 实现 `AgentRunner` 接口，冷启动 CLI 子进程
2. CLI 在 workspaceDir 内执行，写 `turn/output.md` + `turn/done.json`
3. signal 传到子进程层，超时能 kill
4. 凭证经环境变量注入，不进镜像/日志/workspace
5. 失败走 Issue 4 的 rollback
6. Random Tool CLI Wrapper 落地（Issue 5 grill 留口）
7. HITL 验收：人工跑一次真实回合

---

### Q2: Claude Code CLI 怎么装进容器？

**选择**: 保持 `node:20-alpine` base，用 **npm 固定版本**安装。

**理由**:
- alpine 3.19+ 官方支持 Claude Code，需 `apk add ripgrep` + `USE_BUILTIN_RIPGREP=0` 解决 musl/bundled ripgrep 问题。
- native installer（`curl install.sh`）版本不固定、auto-update 默认开，Dockerfile 可重复性差。
- npm 安装拉取同一 native binary（经 per-platform optional dependency），node 镜像已有 npm，可固定版本（`@anthropic-ai/claude-code@<version>`）保证可重复构建。
- 不换 base（node:20-slim）——避免改变 Issue 1 已定 base，符合 YAGNI。

**Dockerfile 改动**:
- runner stage `apk add --no-cache ripgrep`（libgcc/libstdc++ 已在 node:20-alpine）
- runner stage `RUN npm install -g @anthropic-ai/claude-code@<version>`（root 装到 `/usr/local/bin/claude`，nextjs 用户可用）
- runner stage `ENV USE_BUILTIN_RIPGREP=0`

**HITL 验收要求**:
- 容器内执行 `claude --version`，记录实际版本号。
- 若 Alpine/npm optional dependency 拉取失败（musl 平台 binary 缺失等），切换到官方 apk 安装方式作为备选，并在 HITL 记录中说明。

---

### Q3: 凭证注入与防泄漏怎么做？

**选择**: 四点全做。

1. **注入机制**: docker-compose `environment: - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`，从宿主 shell 环境变量读，不落盘。docker-compose 默认不设此项（见 Q7），仅在启用 claude 的 compose 文件/env 覆盖中提供。
2. **.dockerignore / .gitignore 补漏**: 加 `.env` 和 `.env.*`（当前只 ignore `.env*.local`，`.env` 会进镜像/仓库）。
3. **子进程 env 白名单**: ClaudeCodeRunner spawn 时显式传 env 白名单，**禁止直接继承全量 `process.env`**。初始白名单：`ANTHROPIC_API_KEY`、`PATH`、`HOME`、`NODE_ENV`、`TMPDIR`、`USE_BUILTIN_RIPGREP`。如 HITL 发现需要额外无敏感运行时变量，可显式加入白名单；禁止以"可能需要"为由放宽到全量继承。
4. **诊断日志脱敏 + 限长**: runner 捕获 CLI stdout/stderr 做诊断时，写入 `logs/turn-errors.log` 前把 `ANTHROPIC_API_KEY` 值替换为 `[REDACTED]`，并对单次 stdout/stderr 限长（建议 16KB/32KB 截断，超出部分丢弃并标注 truncated）——arch-prd"Do not write credentials into logs"硬要求落地，同时防止超长输出撑爆日志。**Web response 仍只来自 `turn/output.md`，不得把 Claude stdout/stderr 返回给 Web。**

**理由**: FakeAgent 不涉及凭证所以 Issue 3-5 没碰；Issue 6 接真实 CLI 后，env 白名单 + 诊断脱敏/限长是凭证安全的唯一防线。env 白名单不过窄（含运行时必需的 TMPDIR/USE_BUILTIN_RIPGREP）也不过宽（禁止全量继承）。

---

### Q4: Claude Code CLI 在容器内的权限模式与调用方式怎么定？

**选择**: `claude --bare -p` + 受控 settings 文件预授权 + prompt 经 stdin/临时文件传递。

**命令形态**:
- 默认命令：`claude --bare -p` + 稳定短参数（如 `--output-format` 等）。
- **使用 `--bare` 模式**减少 hooks/skills/plugins/MCP/CLAUDE.md/auto memory 等外部上下文污染，保证回合执行环境干净、可重复。
- **完整 prompt / playerInput 不放 argv**：argv 只放稳定短参数；完整 prompt 经 stdin 或临时 prompt 文件传递。避免 argv 长度限制、进程列表泄漏（`ps` 可见 argv）、shell 转义问题。

**权限模式**: 受控 settings 文件预授权，不依赖历史用户配置。
- 使用受控 settings 文件（经 `--settings <path>` 或写入容器内固定路径），不依赖 `~/.claude` 历史用户配置，保证可重复。
- `deny`: `.env`、`.env.*`、`secrets/**`——即使 agent 尝试读也拒绝。
- `allow`: 只放必要 `Read`/`Write`/`Bash`，其中 `Bash` 仅允许 `node /app/cli/roll-choice.js`。
- 不使用 `--dangerously-skip-permissions`——放行所有工具含任意 Bash 命令，即使容器隔离也不该作为生产默认。
- **HITL 验收必须确认**：非交互模式（`-p`）下不会因权限询问卡住或失败。

**安全边界来源（明确）**:
- `cwd=workspaceDir` **不是安全沙箱**——claude code 仍可经绝对路径访问容器内其他可读文件。
- 真正的安全边界来自：Docker 容器隔离 + 非 root 用户（nextjs:1001）+ env 白名单（不继承全量 process.env）+ Claude permissions（deny/allow）+ 少挂载（仅 `/app/data` volume）+ 不使用 `--dangerously-skip-permissions`。
- cwd 只是工作目录便利，不是隔离机制。

**子进程调用技术细节**（技术明确，不单独决策）:
- 用 `child_process.spawn`（不用 exec/execFile——spawn 流式 + `signal` 选项支持最好）
- `cwd: workspaceDir`，`signal: req.signal` 传给 spawn
- abort 时 `subprocess.kill('SIGTERM')`，超时 escalate `SIGKILL`（满足 agent-runner.ts"避免 timeout 后幽灵写入"）
- stdout/stderr 收集做诊断（脱敏 + 限长后写 `logs/turn-errors.log`，见 Q3）
- 等 exit，检查退出码（0=成功，非 0=失败），但**权威仍是磁盘 `done.json`**（Orchestrator 已保证，见 done.json 信任边界）

---

### Q5: 随机工具 CLI wrapper 是否在 Issue 6 范围？

**选择**: 包含，宽松验收。

**理由**:
- Issue 5 grill Q2 已明确留口给 Issue 6。
- arch-prd P0 第 20 条"agent 必须调用随机工具"。
- 推迟到 Issue 8 会让 Issue 8 同时做 wrapper + 可玩链路，范围膨胀。
- wrapper 是独立小模块，不复杂。

**验收宽松**: 只要求 claude 能调通 wrapper 把随机结果写进 output，不要求每回合必调。

**实现**:
- wrapper 是独立 TS 文件 `src/cli/roll-choice.ts`，build 阶段编译到 `dist/cli/roll-choice.js`（Next.js standalone 不 trace CLI 路径，需单独编译）
- wrapper 内部 import 并调用 `rollChoice`（复用 `src/lib/random-tool.ts`，不重复逻辑）
- 输入：stdin JSON（`candidates` 是数组，argv 转义麻烦）
- 输出：stdout JSON（`RollChoiceResult`），失败非零退出 + stderr 错误
- claude 经 Bash 调 `node /app/cli/roll-choice.js`，读 stdout 拿结果

**Build 依赖完整性（关键）**:
- Docker runner stage **不能只 `COPY dist/cli`**——wrapper import `dist/lib/random-tool.js` 等依赖，只复制 cli 目录会导致运行时 import 失败。
- 两种可行方案（plan 阶段择一）:
  1. 复制完整 `dist/`（含 `dist/cli` + `dist/lib` + 任何 runtime 依赖），保证 import 链完整。
  2. 用 bundler（如 esbuild）把 wrapper bundle 成单文件（含所有依赖），只 `COPY dist/cli/roll-choice.js` 单文件。
- **CI/HITL 必须验证**：production-like 镜像内执行 `node /app/cli/roll-choice.js` 可正常运行（传入合法 stdin JSON 返回 stdout JSON），不能只在 dev 机器上验证。

---

### Q6: 首版 agent prompt 怎么放、粒度多细？

**选择**: 代码常量 + 完整故事指令 + 含输出隔离约束。

**放置**: `src/lib/claude-prompt.ts` 作为代码常量，runner 读取并填充 `playerInput`。
- **后续可迁移到 `prompts/story-turn-runner.md`**——本 issue 先放代码常量便于版本管理与 runner 引用；若 prompt 变长或需多版本管理，后续 issue 可迁移到 `prompts/` 目录作为资源文件。本 issue 不强制迁移。

**传递方式（见 Q4）**:
- runner 把填充后的完整 prompt 经 **stdin 或临时 prompt 文件**传给 `claude --bare -p`，**不放 argv**。
- argv 只放稳定短参数。

**理由**:
- prompt 是代码资产需版本管理；workspace 是故事状态不该放 prompt。
- 虽然 Issue 6 不追求故事质量，但 prompt 本身要正确为 Issue 7/8 准备。
- 输出隔离从第一天写进 prompt 比之后补更稳（Issue 9 专门强化，但 Issue 6 要有基础）。

**prompt 骨架**:
```
你是故事模拟引擎的回合执行 agent。当前工作目录是 Story Workspace。

## 任务
执行主角本回合行动，推进故事一个回合。

## 输入
{playerInput}

## 工作流程
1. 读取 workspace 状态：story.md, world.md, player.md, rules.md, turn/input.md
2. 理解主角意图，推进故事一个回合
3. 如有不确定/风险判定，调用随机工具：echo '<JSON>' | node /app/cli/roll-choice.js
4. 写 turn/output.md（主角可见输出）
5. 写 turn/done.json：{"status":"success","completedAt":"<ISO>"}

## 约束
- output.md 只写主角视窗：主角能看/听/感知/推理的信息
- 不得泄漏：God State 真相、NPC 私有记忆、内部日志、随机判定日志内容
- 不得修改 story.md 元数据
- 完成必须写 done.json；无法完成则不写（触发回滚）
```

---

### Q7: Runner 切换策略怎么定？

**选择**: 环境变量切换，默认 FakeAgent。docker-compose 默认不强制 claude。

```ts
const runner = process.env.AGENT_RUNNER === "claude"
  ? new ClaudeCodeRunner()
  : new FakeAgentRunner();
const orchestrator = new TurnOrchestrator(runner);
```

**理由**:
- arch-prd 要求能切回 FakeAgent——环境变量最简，不引入配置文件系统（YAGNI）。
- 默认 FakeAgent 保证 vitest 契约测试不依赖真实 CLI/凭证/网络。
- **docker-compose 默认不设 `AGENT_RUNNER=claude`**——避免没有 `ANTHROPIC_API_KEY` 时普通开发跑不起来。启用 claude 经 env 覆盖（`AGENT_RUNNER=claude` + `ANTHROPIC_API_KEY=...`）或额外 compose 文件（如 `docker-compose.claude.yml`）完成。
- ClaudeCodeRunner 构造函数接受可选配置（`spawnFn`/`claudePath`/`promptTemplate`），默认从环境变量/常量读，route.ts 用默认构造。

---

### Q8: ClaudeCodeRunner 的测试策略怎么定？

**选择**: 三层测试 + 依赖注入。

1. **依赖注入 spawn**: ClaudeCodeRunner 构造函数接受可选 `spawnFn`，默认用 `child_process.spawn`。这让 runner 可测且不耦合真实进程。
2. **单元测试**（进 CI）: 注入 mock spawnFn，验证调用参数（命令、cwd、env 白名单、signal 传递）、abort 时 kill SIGTERM→SIGKILL、退出码处理、stdout/stderr 捕获、**脱敏**（构造含 `ANTHROPIC_API_KEY` 的 stderr，验证 redact 为 `[REDACTED]`）。
3. **集成测试**（进 CI）: `tests/fixtures/fake-claude.mjs` 模拟 claude 行为（写 `output.md`+`done.json`，或模拟失败/超时），runner 用真实 spawn 调 fake CLI，验证磁盘契约。
4. **HITL 验收**（不进 CI）: 人工跑真实 claude code，确认管道通。这是 Issue 6 标 HITL 的原因。

**关键点**: mock spawn 单元测试覆盖 signal/kill/脱敏契约；fake CLI 集成测试覆盖"子进程写磁盘 → runner 读磁盘"端到端；真实 claude 只人工验收。

---

### Q9: 真实 claude 的回合超时定多少？

**选择**: docker-compose 设 `TURN_TIMEOUT_MS=180000`（3 分钟），代码默认仍 60s。

**理由**:
- Issue 4 已设计 `TURN_TIMEOUT_MS` 环境变量，生产调大即可，零代码改动。
- 不动默认值，vitest 契约测试（FakeAgent 瞬时）不受影响。
- 180s 对 Issue 6 管道验证（占位 workspace，简单回合）足够；Issue 8 真实可玩再按需调。
- 超时后 Orchestrator 已有 rollback 兜底（Issue 4），不会因超时污染 workspace。

---

### 失败模式与 workspace 污染（不单独决策）

**结论**: Issue 4 的 Orchestrator 机制已全覆盖，Issue 6 不需额外失败处理。

- 缺 `done.json` / 缺/空 `output.md` / runner 异常 / 超时 → `failTurn` → rollback
- rollback 是整目录恢复，claude 写的乱文件随 rollback 删除
- rollback 失败 → `markWorkspaceUnsafe`（Issue 4 灾难路径已处理）
- **output.md 内容泄漏 God State**: Issue 6 不做内容校验。理由：Issue 9 专门做输出隔离强化；Issue 6 workspace 是占位内容无真实 God State 可泄漏；prompt 已有约束。Issue 6 只靠 Issue 4 的"非空"校验。

ClaudeCodeRunner 只需：调子进程 → 等退出 → 返回 `{success, error?}`。磁盘权威和污染清理全交给 Orchestrator。

### done.json 信任边界（明确）

- `done.json` 仍由 agent（claude code）写入，可接受。
- **Orchestrator 只信任 `status=success`**，不信任 `completedAt`——`completedAt` 是诊断字段，不作为成功判定依据，agent 写错/写空 `completedAt` 不影响回合成功判定（只要 `status=success` 且 `output.md` 非空）。
- 这与 [turn-orchestrator.ts](file:///e:\User_File\project\Project\rpg4pov\src\lib\turn-orchestrator.ts) 现有实现一致（只检查 `done.status !== "success"`），Issue 6 不改此逻辑，仅明确语义。

---

## 最终验收边界

Issue 6 完成时应能证明：

1. ClaudeCodeRunner 实现 `AgentRunner` 接口，冷启动 `claude --bare -p` CLI 子进程执行回合。
2. CLI 在 workspaceDir 内自主读写，写 `turn/output.md` + `turn/done.json`（`status=success`）。
3. signal 传到子进程层，超时 SIGTERM→SIGKILL，无幽灵写入。
4. 凭证经 `ANTHROPIC_API_KEY` 环境变量注入，不进镜像/日志/workspace。
5. 子进程 env 白名单传递（`ANTHROPIC_API_KEY`/`PATH`/`HOME`/`NODE_ENV`/`TMPDIR`/`USE_BUILTIN_RIPGREP`），禁止全量继承 `process.env`；诊断日志脱敏（`ANTHROPIC_API_KEY` → `[REDACTED]`）+ 限长（16KB/32KB 截断）；**Claude stdout/stderr 不返回给 Web，Web response 只来自 `turn/output.md`**。
6. 受控 settings 文件预授权（`--settings` 或固定路径），不依赖历史用户配置；`deny` `.env`/`.env.*`/`secrets/**`；`allow` 仅必要 Read/Write/Bash（Bash 仅 `node /app/cli/roll-choice.js`）；不用 `--dangerously-skip-permissions`；HITL 确认非交互模式不卡权限询问。
7. 完整 prompt/playerInput 经 stdin 或临时 prompt 文件传递，**不放 argv**；argv 只放稳定短参数。
8. Random Tool CLI Wrapper（`src/cli/roll-choice.ts`）可被 claude 经 Bash 调用，复用 `rollChoice` 逻辑，写 `logs/random-rolls.jsonl`；production-like 镜像内 `node /app/cli/roll-choice.js` 可正常运行（build 依赖完整，非只 COPY dist/cli）。
9. 首版 agent prompt 放 `src/lib/claude-prompt.ts`（后续可迁移 `prompts/story-turn-runner.md`），含完整故事指令 + 输出隔离约束。
10. `AGENT_RUNNER=claude|fake` 环境变量切换，默认 fake；**docker-compose 默认不强制 claude**，启用 claude 经 env 覆盖或额外 compose 文件。
11. 单元测试（mock spawn）覆盖参数/signal/kill/脱敏/限长契约；集成测试（fake CLI）覆盖磁盘契约；真实 claude HITL 人工验收（含 `claude --version` 记录）。
12. docker-compose（启用 claude 时）设 `TURN_TIMEOUT_MS=180000`，代码默认仍 60s。
13. 失败（非零退出/超时/缺 done/缺 output）走 Issue 4 rollback，workspace 污染随整目录恢复清除；Orchestrator 只信任 `done.json` 的 `status=success`，不信任 `completedAt`。
14. .dockerignore / .gitignore 补 `.env` / `.env.*`，防止凭证文件进镜像/仓库。
15. 安全边界明确：`cwd=workspaceDir` 不是安全沙箱；真正隔离来自 Docker + 非 root + env 白名单 + Claude permissions + 少挂载 + 不用 dangerously skip permissions。

---

## 不创建 ADR 的理由

本 issue 的决策延续 Issue 1-5 已锁定的架构边界：AgentRunner 接口、Turn Orchestrator 磁盘权威、Markdown-first Story Workspace、整目录快照回滚、logs/ 内部日志。Issue 6 引入的 ClaudeCodeRunner、CLI Wrapper、环境变量切换都是这些边界内的具体实现，不是新的难逆转架构取舍——CLI 安装方式、权限模式、prompt 放置、超时值都可调。未来读者可以从 `CONTEXT.md` 与本 grill 记录理解原因，不需要单独 ADR。

---

## Plan 级约束补充（进入 plan 前锁定）

以下 4 点在 grill 决策基础上进一步约束 plan 阶段的实现细节，plan 必须遵守。

### P1: Claude settings permission 规则要落成真实语法

- `deny` 用真实 permission 语法形式，如 `Read(./.env)`、`Read(./.env.*)`、`Read(./secrets/**)`——不是自然语言描述。
- `allow` 里的 `Bash` 规则要能匹配实际 roll-choice 调用命令。
- **随机工具调用建议用 heredoc 形式**：`node /app/cli/roll-choice.js <<'JSON' ... JSON`，避免 `echo | pipe` 导致 Bash permission pattern 匹配不上（pipe 会让命令字符串包含 `echo` 和 `|`，与 `node /app/cli/roll-choice.js` pattern 不匹配）。
- plan 阶段要给出 settings.json 的完整真实内容示例，含 deny/allow 的具体语法。

### P2: prompt 传递方式 plan 阶段必须二选一

- **建议使用临时 prompt 文件**：放 `/tmp` 或 runner 私有临时目录（如 `/tmp/claude-prompts/<random>.md`），**不放 Story Workspace**（workspace 是故事状态，不该放 prompt）。
- 临时文件用完即删（runner finally 清理），避免泄漏到磁盘。
- 如果选择 stdin，必须在 HITL 中确认 `claude --bare -p` 能按预期读取完整输入（某些 CLI 实现对 stdin 行为不一致）。
- plan 必须明确择一，不能留"stdin 或临时文件"二选一。

### P3: Claude stdout/stderr 只在失败诊断时写入日志

- **成功回合不默认写 stdout/stderr 到 workspace**——成功时 stdout/stderr 丢弃，只读 `turn/output.md`。
- **失败回合**：runner 捕获 stdout/stderr，脱敏（`ANTHROPIC_API_KEY` → `[REDACTED]`）+ 限长（16KB/32KB 截断）后写入 `logs/turn-errors.log`。
- **不得返回给 Web**——Web response 只来自 `turn/output.md`，与 Q3/验收 5 一致，此处强调成功/失败两种路径都不返回 stdout/stderr。

### P4: 受控 settings 文件不要放进 Story Workspace

- settings 文件放**容器受控路径**，如 `/app/claude/settings.json` 或 `/home/nextjs/.claude/settings.json`。
- **不放 Story Workspace**——workspace 是故事状态，settings 是运行时配置，混放会污染故事状态且随 rollback 被误删。
- Dockerfile 在构建阶段写入受控路径，运行时只读。
