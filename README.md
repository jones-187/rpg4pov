# rpg4pov

小场景、多角色、主角视角受限的 AI 故事模拟引擎。目标体验偏 galgame、同人游戏和视觉小说：以人物关系、角色对话、主角第一人称内心独白和 NPC 主动行动推动故事。

当前仓库状态：**性能优化分支（dev/perf）：Story Turn 已迁移到 pi coding agent——服务端预注入上下文、模型并行写三产物（output / interaction / state-update 单文件）、服务端解析合并并写 done 标记；Story Initialization 保留 claude CLI（延迟不敏感的开放创作）。端到端实测（WSL Docker + NewAPI + qwen-fp8）：init ~2 分钟、回合冷 ~61s / 暖 ~43s（迁移前 ~3 分钟）。随机判定经预掷随机数池进入 pi 回合路径：服务端 crypto 预生成样本注入 prompt、模型按序消耗申报、服务端权威重算落账审计日志（CONTEXT.md「Pre-rolled Random Pool」）。决策记录与被否决备选见 `docs/adr/0001-pi-turn-runner.md`**。
此前 Issue 7-14 已实现并验收（含 Issue 13 NPC 情感连续性、Issue 14 committed history 隔离）；性能优化分支同时关闭了 Issue 14 遗留的"权限层 Docker 复验"：实测 claude CLI 2.1.140 + 网关环境下 settings 路径规则对 Write 完全不匹配，init 改 `--tools=Read,Write` + auto，受保护文件（turns/**、story.md、turn/input.md）由 orchestrator 基线比对守卫 fail-closed 保护。
首页可创建/列出故事，进入故事页先填写小场景设定完成初始化（`create → init → turn` 状态机在 API 层强制），再发送主角输入；后端按 storyId 定位独立 workspace，`AGENT_RUNNER=claude` 时按 task 分发 runner（turn → Pi Runner、init → Claude Code Runner；默认 Fake Agent），返回主角可见输出，开场与每回合追加到玩家可见历史。
已具备单回合安全边界（串行、快照、失败回滚、受保护路径基线守卫）、输出格式契约校验（首行 `# 主角视窗`，不合规回合失败回滚）；committed 玩家历史 exclusively 由 orchestrator 提交——agent 执行期间对 `turns/history.jsonl` 的任何改动都会被逐字比对拦截并整轮回滚。
回合 prompt 已包含 Narrative Turn Contract（有效变化、NPC 意图、视觉小说式表演）、主角运行时控制权边界与心理描写规则、玩家反馈与长期适应（`adjustments.md` / `tendencies.md`）；回合交互状态（连续演出 / 决策点 + 0-4 条建议）经 `turn/interaction.json` 净化后返回，UI 提供"继续"按钮与建议填入。
NPC 情感连续性（Issue 13）：核心 NPC 角色卡分层维护 Emotional Core（稳定情感核心）、Relationship State（对主角的方向性关系认知）、Emotionally Salient Memories（event/meaning/impact 私人意义记忆）与增强版 Current Intent（含 emotionalTrigger / emotionalConflict / restraint / behaviorStrategy）；回合生成遵循 Trigger→Meaning→Conflict→Strategy→Performance→Delta 内部推理链，关系状态只在有明确依据时保守更新。主角可拥有即时情绪，但重大心理结论仍由玩家决定。
已保存并展示玩家可见的回合历史（`turns/history.jsonl`，含 opening 开场条目）。

当前产品路线已明确：不预写固定剧本、章节、角色路线或结局；每个正常回合必须产生玩家可感知的有效变化。系统可以自动演出符合主角人格的低风险心理活动、台词和自然反应，但关键关系方向、重大承诺、信任、原谅和不可逆决定必须交还玩家。

## 本地开发

需要 Node 20+ 与 pnpm 9（通过 corepack 自动启用）。

```bash
corepack enable
pnpm install
pnpm dev
```

打开 http://localhost:3002

开发模式下 Story Workspace 落在 `./data/workspaces/{storyId}/`（由 `WORKSPACE_ROOT` 控制，默认 `./data/workspaces`）。

## 测试

```bash
pnpm test       # Vitest：workspace 领域 + API 契约（注入 tmpdir，不碰真实数据）
pnpm build      # 类型检查 + 生产构建
```

## Docker 运行（单容器，数据持久化）

### 默认模式（Fake Agent，无需 API 配置）

```bash
docker compose up --build
```

使用 Fake Agent 返回固定输出，适合测试和开发。

### Claude 模式（真实 AI 响应）

1. 创建 `.env` 文件配置 API：

```env
# 第三方 API（如 OpenRouter、自建代理）
ANTHROPIC_AUTH_TOKEN=your-token
ANTHROPIC_BASE_URL=https://your-api-proxy
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# 或官方 API
ANTHROPIC_API_KEY=sk-ant-xxx
```

Anthropic 协议兼容网关同样可用（实测：NewAPI 网关 + Qwen 模型，`ANTHROPIC_BASE_URL` 填网关根地址、`ANTHROPIC_MODEL` 填网关内的模型名）。注意镜像内 claude CLI 锁定 **2.1.140**：v2.1.142+ 会把 system 消息放进 messages 数组非开头位置，部分第三方网关（new-api 等）会返回 400 "System message must be at the beginning"，官方 API 不受影响。

2. 使用 claude compose 覆盖文件启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.claude.yml up --build
```

打开 http://localhost:3002 ，创建故事并发送输入。

- 仅暴露 3002 端口；
- 故事数据通过 named volume `rpg4pov-data` 挂到 `/app/data`，`compose down`（不带 `-v`）后重建容器数据不丢；
- 镜像内不含源码、测试与文档，不内置任何凭证。

## Story Workspace 布局

```
{WORKSPACE_ROOT}/{storyId}/
  story.md              # id / title / createdAt（front matter）；初始化后追加 initialized / initializedAt（Web 侧写入，agent 无权写）
  rules.md              # 占位
  world.md              # 占位
  player.md             # 占位（主角）
  adjustments.md        # Confirmed Adjustments 玩家确认修正（Issue 9.5；初始为空）
  tendencies.md         # Inferred Tendencies 推测倾向（Issue 9.5；初始为空）
  actors/.gitkeep       # 占位（NPC 角色卡目录）
  logs/.gitkeep         # 内部日志目录
  logs/random-rolls.jsonl # 随机判定日志（成功回合追加；claude 路径 agent 经 CLI 写入，pi 路径由 Web 侧权威落账；不对用户可见）
  logs/turn-errors.log  # 回合失败诊断日志（内部）
  turn/input.md         # 本回合主角输入（"继续"系统命令时为系统指令文本）
  turn/output.md        # 本回合固定主角可见输出（Web 唯一返回源）
  turn/interaction.json # 回合交互状态：continue|decision + 0-4 条建议（Issue 10；Web 只返回净化版本）
  turn/state-update.md  # 状态变更单（pi 回合内部中间产物：=== FILE: x === + APPEND/REPLACE 服务端解析合并落盘；=== RANDOM === 段为随机数池消耗申报，服务端核对后落审计日志）
  turn/done.json        # 运行成功标记（pi 路径由 Web 侧在解析合并后写入，init 路径由 agent 写入；orchestrator 以其磁盘存在性判定成败，回合前清理）
  turns/history.jsonl   # 已提交的玩家可见回合历史（Issue 6.5；含 opening 与 turn 两类条目）
```

pi 回合运行时可调环境变量：`PI_HISTORY_LIMIT`（prompt 注入的历史条数上界，默认 5）、`PI_MAX_ATTEMPTS`（"口述不写盘"失效自动重试次数，默认 2、上限 3）、`PI_PATH`（pi 可执行文件路径覆盖，默认 `pi`）、`PI_EARLY_EXIT`（早退看门狗：三产物落盘即 SIGTERM 跳过收尾往返，默认开，`=0` 关闭）、`PI_ACTOR_BUDGET_BYTES`（单张角色卡字节预算，超限注入瘦身指令，默认 6144，夹取 2048-65536）。模型经 `ANTHROPIC_MODEL` 指定，默认且验收锁定 `qwen-fp8`；pi 的 provider 配置（`~/.pi/agent/models.json`）由应用从 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）幂等生成，不进镜像。

主角可见输出只来自 `turn/output.md`；Web 不读取 agent stdout、logs、world、player、actors。
玩家可见历史来自 `turns/history.jsonl`，是已提交的完整回合记录。
