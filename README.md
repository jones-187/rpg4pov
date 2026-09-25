# rpg4pov

小场景、多角色、主角视角受限的 AI 故事模拟引擎。目标体验偏 galgame、同人游戏和视觉小说：以人物关系、角色对话、主角第一人称内心独白和 NPC 主动行动推动故事。

后续改造先遵循[模型能力边界复盘与工程止损规则](docs/model-capability-retrospective.md)：区分工程缺陷与模型能力不足，先有限归因，再决定是否值得修改；不无限增加语义补丁、代理层或重试。

当前仓库状态：**性能优化分支第一阶段：Story Turn 继续由 Pi 执行；Story Initialization 由同一个 PiRunner 严格分为 Phase 1 概念 Bundle 与 Phase 2 主角可见 opening，两阶段都由服务端校验、应用/提交并写 done 标记；`AGENT_RUNNER=claude` 保留 turn→Pi、init→Claude 的 A/B 基线。** Pi init 的 Phase 1 只写 `turn/state-update.md`，Phase 2 只写 `turn/output.md` 与 `turn/interaction.json`；受控 write extension 做执行前边界，workspace manifest 做执行后纵深校验。随机判定仅进入 Pi 回合路径：模型先写 `turn/roll-request.json` 提交候选，服务端校验后抽样并把绑定结果注入后续 context；context 不暴露 sample，模型必须在最终 `state-update.md` 中逐条原样确认，申报不完全匹配则整轮失败，重试不重复抽样。决策记录与被否决备选见 `docs/adr/0001-pi-turn-runner.md`。
历史 Issue 7-14 验收记录（含 Issue 13 NPC 情感连续性、Issue 14 committed history 隔离）保留作基线，不等同于当前 Pi 路径的真实质量已通过；性能优化分支同时关闭了 Issue 14 遗留的"权限层 Docker 复验"：实测 claude CLI 2.1.140 + 网关环境下 settings 路径规则对 Write 完全不匹配，init 改 `--tools=Read,Write` + auto，受保护文件（turns/**、story.md、turn/input.md）由 orchestrator 基线比对守卫 fail-closed 保护。
首页可创建/列出故事，进入故事页先填写小场景设定完成初始化（`create → init → turn` 状态机在 API 层强制），再发送主角输入；后端按 storyId 定位独立 workspace，`AGENT_RUNNER=pi` 时 init/turn 共用 Pi Runner，`AGENT_RUNNER=claude` 时按 task 分发 runner（turn → Pi Runner、init → Claude Code Runner；默认 Fake Agent），返回主角可见输出，开场与每回合追加到玩家可见历史。
已具备单回合安全边界（串行、快照、失败回滚、受保护路径基线守卫）、输出格式契约校验（首行 `# 主角视窗`，不合规回合失败回滚）；committed 玩家历史 exclusively 由 orchestrator 提交——agent 执行期间对 `turns/history.jsonl` 的任何改动都会被逐字比对拦截并整轮回滚。
回合 prompt 已包含 Narrative Turn Contract（有效变化、NPC 意图、视觉小说式表演）、主角运行时控制权边界与心理描写规则、玩家反馈与长期适应（`adjustments.md` / `tendencies.md`）；回合交互状态（连续演出 / 决策点 + 0-4 条建议）经 `turn/interaction.json` 净化后返回，UI 提供"继续"按钮与建议填入。
NPC 情感连续性（Issue 13）：核心 NPC 角色卡分层维护 Emotional Core（稳定情感核心）、Relationship State（对主角的方向性关系认知）、Emotionally Salient Memories（event/meaning/impact 私人意义记忆，压缩时保护承诺、起源、伤害、私人象征等定义性记忆）与增强版 Current Intent（含 emotionalTrigger / emotionalConflict / restraint / behaviorStrategy）；回合生成遵循 Trigger→Meaning→Conflict→Strategy→Performance→Delta 内部推理链，关系状态只在有明确依据时保守更新。主角可拥有即时情绪，但重大心理结论仍由玩家决定；用户指定的 POV 优先，正文没有固定短篇幅或 300 字截断要求。
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
ANTHROPIC_MODEL=deepseek-v4.1-flash

# 或官方 API
ANTHROPIC_API_KEY=sk-ant-xxx
```

Anthropic 协议兼容网关同样可用（当前实测：NewAPI 网关 + DeepSeek 模型，`ANTHROPIC_BASE_URL` 填网关根地址）。项目把 `ANTHROPIC_MODEL` 硬锁为 `deepseek-v4.1-flash`：缺省时自动使用该值，配置为其他值会直接拒绝启动 agent，不会回退或换模型。注意镜像内 claude CLI 锁定 **2.1.140**：v2.1.142+ 会把 system 消息放进 messages 数组非开头位置，部分第三方网关（new-api 等）会返回 400 "System message must be at the beginning"，官方 API 不受影响。

2. 使用 claude compose 覆盖文件启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.claude.yml up --build
```

打开 http://localhost:3002 ，创建故事并发送输入。

### Pi 模式（统一 init/turn 候选路径）

使用同一份 `.env` 配置 Pi coding agent：

```bash
docker compose -f docker-compose.yml -f docker-compose.pi.yml up --build
```

第一阶段仍保留 Claude compose 作为质量基线；自动测试使用 fake runner/fake-pi，不访问网络或真实模型。

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
  turn/roll-request.json  # 程序保存的随机候选请求（校验后抽样，sample 不进入模型 context）
  turn/state-update.md  # 状态候选存档：init 为完整 Workspace Bundle；turn 保存规范化的 sections/rolls JSON（严格兼容旧 Markdown 变更单，不放宽旧语法）
  turn/done.json        # 运行成功标记（Pi init/turn 均由 Web 侧在校验/合并后写入；Claude 基线 init 由 agent 写入；orchestrator 以其磁盘存在性判定成败，回合前清理）
  turns/history.jsonl   # 已提交的玩家可见回合历史（Issue 6.5；含 opening 与 turn 两类条目）
```

Pi 运行时可调环境变量：`PI_HISTORY_LIMIT`（prompt 注入的历史条数上界，默认 5）、`PI_MAX_ATTEMPTS`（每阶段生成尝试次数，默认 2、上限 3）、`PI_PATH`（pi 可执行文件路径覆盖，默认 `pi`）、`PI_EARLY_EXIT`（仅 init 的产物早退看门狗，默认开，`=0` 关闭）、`PI_UNCOMMITTED_PREVIEW`（仅 init 的未提交预览实验，默认关闭，仅 `=1` 启用）、`PI_ACTOR_BUDGET_BYTES`（单张角色卡字节预算，超限注入瘦身指令，默认 6144，夹取 2048-65536）、`PI_WRITE_BOUNDARY_EXTENSION_PATH`（init 受控 write extension 路径，默认 `/app/pi-extensions/write-boundary.ts`）、`CLAUDE_EARLY_EXIT`（Claude init done.json 看门狗，默认开，`=0` 关闭）。模型经 `ANTHROPIC_MODEL` 指定，默认且验收锁定 `deepseek-v4.1-flash`；pi 的 provider 配置（`~/.pi/agent/models.json`）由应用从 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）幂等生成，不进镜像。

Pi init 仍使用受控 extension：Phase 1 仅写 `turn/state-update.md`，Phase 2 仅写 `turn/output.md` 与 `turn/interaction.json`。Phase 1 的 player.md 必须有独立 `## Public Scene` JSON，包含 time、location、narrativeVoice、knownFacts、visibleActors；开场只读取这份严格校验的公开资料，不读取人物私密段或“初始状态”整段。

普通 turn 和实验分离阶段使用 `--no-tools`，并关闭上下文文件、扩展和技能自动发现。模型仅返回完整 JSON：普通回合为 `{kind:"turn", output, interaction, stateUpdate}`，需要随机时先返回 `{kind:"roll-request", rolls}`。程序从正常结束的 assistant 事件读取正文字段，拒绝部分事件、思考内容、工具调用、截断响应、裸小说与缺失字段；不从旧磁盘文件兜底。实验计划为 `{kind:"scene", publicScene, visibleEvents, stateUpdate, interaction}`，叙事为 `{kind:"render", output}`，公开场景必须对应本回合而非初始化旧时点。每次模型执行后都检查 workspace manifest，普通回合模型造成任何文件变化都失败；只有程序可以在校验通过后写入候选，正式提交或回滚继续由 Orchestrator 负责。

无工具生成显式加载受控 `pi-extensions/json-response.ts`（`PI_RESPONSE_EXTENSION_PATH` 可配置路径），只设置请求的 `response_format=json_object`，不提供文件工具。扩展缺失时启动失败，不默默降级；响应仍须通过本地完整校验。`newapi-response` 与初始化使用同一服务和 `deepseek-v4.1-flash`，显式使用 DeepSeek thinking 协议；普通完整回合使用 Pi 0.73.1 的最高合法档 `--thinking xhigh`（产品口径 max）。初始化保持原 provider 和工具配置。JSON 语法约束不保证故事与状态语义一致，模型切换后的完整质量门仍待有限对照。

`stateUpdate` 使用 `{sections:[{file,ops:[{kind:"append",text}|{kind:"replace",from,to}]}],rolls:[]}`。多行内容直接放入 JSON 字符串；空 sections/rolls 明确表示无变化。替换旧文仍必须唯一匹配，未知字段、非法路径、重复文件段和无效操作整批拒绝。绑定随机后 rolls 必须逐项确认服务端提供的 index、rollId、candidates、declaredSelectedId；保存随机请求失败即终止回合。

普通 turn 与实验分离路径不发布未提交正文，也不基于旧文件早退。仅 Pi init Phase 2 保留显式的 `PI_UNCOMMITTED_PREVIEW=1` 实验：必须等本次 output 与 interaction 事件都到齐，并用本次 interaction 原文做泄密校验；预览不是权威，最终以已提交回合为准，Phase 1 不发布 opening 预览。

PiRunner 提供 `experimentalSceneSeparation` 构造选项，用于实验性的“世界事件/状态计划 → 限知叙事渲染”链路，默认产品不启用。独立验收 CLI 已提供 `--separated` 入口；真实长局质量仍待验证。

## 隔离质量验收

使用新空目录，显式配置现有模型服务后运行（会产生真实模型调用费用）：

```bash
pnpm build:cli
node dist/cli/story-eval.js --workspace-root /tmp/rpg4pov-eval-workspaces --report-dir /tmp/rpg4pov-eval-report --scenario docs/acceptance/scenarios/continuity.json --limit 2
```

`--limit 0` 仅初始化；去掉 limit 会运行场景中全部 30 条输入。另用全新目录加 `--separated` 可对照实验路径；`--init-runner claude` 显式选择初始化基线。失败会停止，逐回合 JSONL 与快照保存在报告目录；工具不会自动读取 `.env` 或复用已有故事。离线替身运行只能验证流程，不能作为真实叙事质量验收。

主角可见输出只来自 `turn/output.md`；Web 不读取 agent stdout、logs、world、player、actors。
玩家可见历史来自 `turns/history.jsonl`，是已提交的完整回合记录。
