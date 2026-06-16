# rpg4pov

小场景、多角色、主角视角受限的 AI 故事模拟引擎。

当前仓库状态：**Issue 1 — Docker 化极简 Web 故事壳（tracer bullet）**。
仅包含 Web 壳与占位故事回合，尚未接入 Story Workspace、agent runtime 与随机工具。

## 本地开发

需要 Node 20+ 与 pnpm 9（通过 corepack 自动启用）。

```bash
corepack enable
pnpm install
pnpm dev
```

打开 http://localhost:3000

## 测试

```bash
pnpm test       # Vitest，API 契约
pnpm build      # 类型检查 + 生产构建
```

## Docker 运行（单容器）

```bash
docker compose up --build
```

打开 http://localhost:3000 ，在输入框输入主角行动，发送后将看到占位响应。

仅暴露 3000 端口；镜像内不含源码、测试与文档，不内置任何凭证。
