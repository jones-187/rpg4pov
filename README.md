# rpg4pov

小场景、多角色、主角视角受限的 AI 故事模拟引擎。

当前仓库状态：**Issue 5 — 工具真随机 roll-choice seam**。
首页可创建/列出故事，进入故事页发送主角输入；后端按 storyId 定位独立 workspace，通过 Fake Agent 返回固定主角可见输出。
已具备单回合安全边界（串行、快照、失败回滚）和内部随机工具 seam；尚未接入初始化 agent 与真实 Claude Code agent runtime（属后续 issue）。

## 本地开发

需要 Node 20+ 与 pnpm 9（通过 corepack 自动启用）。

```bash
corepack enable
pnpm install
pnpm dev
```

打开 http://localhost:3000

开发模式下 Story Workspace 落在 `./data/workspaces/{storyId}/`（由 `WORKSPACE_ROOT` 控制，默认 `./data/workspaces`）。

## 测试

```bash
pnpm test       # Vitest：workspace 领域 + API 契约（注入 tmpdir，不碰真实数据）
pnpm build      # 类型检查 + 生产构建
```

## Docker 运行（单容器，数据持久化）

```bash
docker compose up --build
```

打开 http://localhost:3000 ，创建故事并发送输入。

- 仅暴露 3000 端口；
- 故事数据通过 named volume `rpg4pov-data` 挂到 `/app/data`，`compose down`（不带 `-v`）后重建容器数据不丢；
- 镜像内不含源码、测试与文档，不内置任何凭证。

## Story Workspace 布局

```
{WORKSPACE_ROOT}/{storyId}/
  story.md         # id / title / createdAt（front matter）
  rules.md         # 占位
  world.md         # 占位
  player.md        # 占位（主角）
  actors/.gitkeep  # 占位（NPC 角色卡目录）
  logs/.gitkeep    # 内部日志目录
  logs/random-rolls.jsonl # 随机判定日志（成功回合追加；不对用户可见）
  turn/input.md    # 本回合主角输入
  turn/output.md   # 本回合固定主角可见输出（Web 唯一返回源）
```

主角可见输出只来自 `turn/output.md`；Web 不读取 agent stdout、logs、world、player、actors。
