# rpg4pov

小场景、多角色、主角视角受限的 AI 故事模拟引擎。目标体验偏 galgame、同人游戏和视觉小说：以人物关系、角色对话、主角第一人称内心独白和 NPC 主动行动推动故事。

当前仓库状态：**Issue 7-10、9.5 与 Issue 12 已实现并完成本机验证；真实环境链路验收完成（WSL Docker + NewAPI 网关 + claude CLI 2.1.140：init/turn/continue/决策点建议全链路跑通，输出隔离哨兵检查通过）**。剩余为长线主观体验类验收（叙事质量稳定性）。
首页可创建/列出故事，进入故事页先填写小场景设定完成初始化（`create → init → turn` 状态机在 API 层强制），再发送主角输入；后端按 storyId 定位独立 workspace，通过 Fake Agent 或 Claude Code Runner 返回主角可见输出，开场与每回合追加到玩家可见历史。
已具备单回合安全边界（串行、快照、失败回滚）、内部随机工具 seam 和输出格式契约校验（首行 `# 主角视窗`，不合规回合失败回滚）。
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
  logs/random-rolls.jsonl # 随机判定日志（成功回合追加；不对用户可见）
  logs/turn-errors.log  # 回合失败诊断日志（内部）
  turn/input.md         # 本回合主角输入（"继续"系统命令时为系统指令文本）
  turn/output.md        # 本回合固定主角可见输出（Web 唯一返回源）
  turn/interaction.json # 回合交互状态：continue|decision + 0-4 条建议（Issue 10；Web 只返回净化版本）
  turn/done.json        # 运行成功标记（runner 回合成功后写入；orchestrator 以其磁盘存在性判定成败，回合前清理）
  turns/history.jsonl   # 已提交的玩家可见回合历史（Issue 6.5；含 opening 与 turn 两类条目）
```

主角可见输出只来自 `turn/output.md`；Web 不读取 agent stdout、logs、world、player、actors。
玩家可见历史来自 `turns/history.jsonl`，是已提交的完整回合记录。
