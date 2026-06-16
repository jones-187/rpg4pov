# Issue 1: Docker 化极简 Web 故事壳 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户能通过浏览器打开本地 Web 页面，看到故事显示区、输入框和发送按钮，提交输入后后端返回占位故事响应；应用以 Docker 单容器启动并暴露 Web 端口。

**Architecture:** Next.js (App Router) + TypeScript 全栈单应用。前端为客户端组件，通过 `fetch` 调用同源 `POST /api/story-turn`；API 返回占位的 `playerResponse`。生产镜像采用 Next standalone 多阶段构建，单容器仅暴露 3000 端口。本 issue 是 tracer bullet，**不**包含 Story Workspace、agent runtime、随机工具、storyId 隔离、快照回滚（这些属 Issue 2–9）。

**Tech Stack:** Next.js 15、React 19、TypeScript 5、pnpm 9、Node 20-alpine、Vitest 2。

---

## Scope & Spec Coverage

依据 `docs/issue.md` Issue 1 与 `docs/arch-prd.md`。本计划覆盖：

- 极简 Web 页面（故事显示区 + 输入框 + 发送按钮）— arch-prd P0-1
- Next.js / React 全栈壳 — arch-prd P0-2、Decisions-2/3
- Docker 单容器运行，仅暴露 Web 端口 — arch-prd P0-3/4、Decisions-4/5
- 占位故事回合：输入 → API → 占位响应 — Issue 1 目标行为
- 提交后 loading 态，回合完成后一次性返回 — arch-prd P0-23、Decisions-40/41
- 不返回 agent stdout / 内部日志（本 issue 无 agent，但 API 只返回固定字段，不返回调试信息）— arch-prd P0-18/19

**明确不做（属后续 issue）：** storyId、Story Workspace、agent runner/adapter、随机工具、串行锁、快照回滚、真实故事逻辑、持久化。

## File Structure

```
rpg4pov/
├── package.json                      # 依赖与脚本
├── tsconfig.json                     # TS 配置（含 @/* 路径别名）
├── next.config.mjs                   # Next 配置（standalone 输出）
├── vitest.config.ts                  # Vitest 配置（node env + @ 别名）
├── .gitignore
├── .dockerignore
├── Dockerfile                        # 多阶段 standalone 构建
├── docker-compose.yml                # 本地一键起容器
├── README.md                         # 运行说明
├── public/.gitkeep                   # 保留 public 目录（standalone 需要）
├── src/
│   └── app/
│       ├── layout.tsx                # 根布局
│       ├── globals.css               # 全局样式
│       ├── page.tsx                  # 故事主页面（客户端组件）
│       └── api/
│           └── story-turn/
│               └── route.ts          # POST 占位故事回合
└── tests/
    └── api/
        └── story-turn.test.ts        # API 契约测试
```

职责边界：
- `route.ts` 只负责把输入转成占位 `playerResponse`（后续 issue 会替换为真实 adapter 调用）。
- `page.tsx` 只负责 UI 状态（输入/loading/error/展示）与调用同源 API，不含任何故事逻辑。
- `next.config.mjs` 的 `output: 'standalone'` 仅服务 Docker 镜像，不污染开发体验。

---

## Task 1: 初始化 Next.js + TypeScript 骨架（可编译）

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `next.config.mjs`
- Create: `.gitignore`
- Create: `src/app/layout.tsx`
- Create: `src/app/globals.css`
- Create: `src/app/page.tsx`
- Create: `public/.gitkeep`

- [ ] **Step 1: 初始化 git 仓库**

Run:
```bash
cd /d E:\projects\projects\rpg4pov
git init
git config core.autocrlf false
```
Expected: `Initialized empty Git repository ...`

- [ ] **Step 2: 创建 `.gitignore`**

Create `.gitignore`:
```
# deps
node_modules

# next
.next
out
next-env.d.ts

# env
.env*.local

# misc
*.log
.DS_Store
.idea
.vscode
```

- [ ] **Step 3: 创建 `package.json`**

Create `package.json`:
```json
{
  "name": "rpg4pov",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "next": "15.1.6",
    "react": "19.0.0",
    "react-dom": "19.0.0"
  },
  "devDependencies": {
    "@types/node": "22.10.5",
    "@types/react": "19.0.7",
    "@types/react-dom": "19.0.3",
    "typescript": "5.7.3",
    "vitest": "2.1.8"
  }
}
```

- [ ] **Step 4: 创建 `tsconfig.json`**

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: 创建 `next.config.mjs`**

Create `next.config.mjs`:
```js
/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
```

> 注：`output: 'standalone'` 在 Task 4（Docker）时再加入，使其动机与改动同处一处。

- [ ] **Step 6: 创建 `public/.gitkeep`**

Create `public/.gitkeep`（空文件，保留目录供 standalone 构建使用）。

- [ ] **Step 7: 创建 `src/app/globals.css`**

Create `src/app/globals.css`:
```css
:root {
  --bg: #0f1115;
  --panel: #1a1d24;
  --text: #e6e6e6;
  --accent: #7c9eff;
  --muted: #8a8f98;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}

.container {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px 64px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.container h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  color: var(--accent);
}

.story {
  background: var(--panel);
  border-radius: 8px;
  padding: 20px;
  min-height: 240px;
  white-space: pre-wrap;
  line-height: 1.7;
}

.input-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.input-form textarea {
  width: 100%;
  resize: vertical;
  background: var(--panel);
  color: var(--text);
  border: 1px solid #2c313a;
  border-radius: 8px;
  padding: 12px;
  font-size: 15px;
  font-family: inherit;
}

.input-form button {
  align-self: flex-end;
  background: var(--accent);
  color: #0f1115;
  border: none;
  border-radius: 8px;
  padding: 10px 20px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.input-form button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error {
  color: #ff6b6b;
  font-size: 14px;
}
```

- [ ] **Step 8: 创建 `src/app/layout.tsx`**

Create `src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "小场景故事模拟",
  description: "主角视角受限的多角色异步故事模拟",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 9: 创建占位 `src/app/page.tsx`**

> 该文件会在 Task 3 被替换为真实交互页面。此处只放最小可编译内容，让 `pnpm build` 通过。

Create `src/app/page.tsx`:
```tsx
export default function HomePage() {
  return (
    <main className="container">
      <h1>小场景故事模拟</h1>
      <section className="story">故事壳启动中…（tracer bullet）</section>
    </main>
  );
}
```

- [ ] **Step 10: 安装依赖**

Run:
```bash
cd /d E:\projects\projects\rpg4pov
corepack enable
pnpm install
```
Expected: 安装完成，生成 `pnpm-lock.yaml`。

- [ ] **Step 11: 验证可编译**

Run:
```bash
pnpm build
```
Expected: `✓ Compiled successfully`，无类型错误，生成 `.next`。

- [ ] **Step 12: 提交**

```bash
git add .
git commit -m "chore: scaffold next.js + typescript shell"
```

---

## Task 2: 用 TDD 实现 `POST /api/story-turn` 占位路由

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/api/story-turn.test.ts`
- Create: `src/app/api/story-turn/route.ts`

- [ ] **Step 1: 创建 `vitest.config.ts`**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: 写失败测试**

Create `tests/api/story-turn.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/story-turn/route";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/story-turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/story-turn (placeholder)", () => {
  it("returns 200 with a non-empty playerResponse", async () => {
    const res = await POST(jsonReq({ input: "我走向酒馆门口" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.playerResponse).toBe("string");
    expect(json.playerResponse.length).toBeGreaterThan(0);
  });

  it("echoes the input inside the placeholder narration", async () => {
    const res = await POST(jsonReq({ input: "推开木门" }));
    const json = await res.json();
    expect(json.playerResponse).toContain("推开木门");
  });

  it("returns 400 when input is missing or empty", async () => {
    const res = await POST(jsonReq({ input: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new Request("http://localhost/api/story-turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run:
```bash
pnpm test
```
Expected: FAIL（`Cannot find module '@/app/api/story-turn/route'`）。

- [ ] **Step 4: 实现路由**

Create `src/app/api/story-turn/route.ts`:
```ts
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const rawInput = (body as { input?: unknown }).input;
  const input =
    typeof rawInput === "string" ? rawInput.trim() : "";

  if (!input) {
    return NextResponse.json({ error: "input is required" }, { status: 400 });
  }

  // tracer-bullet 占位：尚未接入 Story Workspace / agent runtime。
  // 后续 issue 会替换为 adapter 调用并只返回固定 player-visible 输出。
  const playerResponse = `(占位回合 · tracer bullet)\n\n主角视窗：${input}\n\n（这是占位响应，尚未接入故事引擎。）`;

  return NextResponse.json({ playerResponse });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run:
```bash
pnpm test
```
Expected: 4 个测试全部 PASS。

- [ ] **Step 6: 验证生产构建仍通过**

Run:
```bash
pnpm build
```
Expected: 编译成功，`/api/story-turn` 作为路由出现。

- [ ] **Step 7: 提交**

```bash
git add .
git commit -m "feat(api): add placeholder story-turn route"
```

---

## Task 3: 故事主页面（客户端组件，接 API）

**Files:**
- Modify: `src/app/page.tsx`（覆盖 Task 1 的占位内容）

- [ ] **Step 1: 用交互式页面覆盖 `src/app/page.tsx`**

Replace the entire contents of `src/app/page.tsx` with:
```tsx
"use client";

import { useState, type FormEvent } from "react";

export default function HomePage() {
  const [narration, setNarration] = useState<string>(
    "故事将从这里开始。在下方输入主角的行动或台词，然后点击发送。"
  );
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/story-turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: text }),
      });

      if (!res.ok) {
        throw new Error(`请求失败（HTTP ${res.status}）`);
      }

      const data = (await res.json()) as { playerResponse: string };
      setNarration(data.playerResponse);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>小场景故事模拟</h1>
      <section className="story" aria-label="故事显示区">
        {narration}
      </section>
      <form onSubmit={handleSubmit} className="input-form" aria-label="主角输入">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入主角的行动或台词…"
          rows={4}
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          {loading ? "处理中…" : "发送"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 2: 验证编译**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 3: 本地运行时冒烟（人工/可阻塞）**

Run:
```bash
pnpm dev
```
打开 `http://localhost:3000`：
- 页面显示故事显示区、输入框、发送按钮。
- 输入「推开木门」并点发送 → 故事区出现以 `(占位回合 · tracer bullet)` 开头、含「推开木门」的文本；按钮在请求期间显示「处理中…」并禁用。
- 输入框留空时发送按钮禁用。

确认后 `Ctrl+C` 停止 dev server。

> 端到端（容器内）自动冒烟在 Task 4 用 curl 完成，此处为人工确认。

- [ ] **Step 4: 提交**

```bash
git add .
git commit -m "feat(ui): interactive story page wired to story-turn api"
```

---

## Task 4: Dockerfile（standalone）+ 容器端到端冒烟

**Files:**
- Modify: `next.config.mjs`（加 `output: "standalone"`）
- Create: `.dockerignore`
- Create: `Dockerfile`

- [ ] **Step 1: 在 `next.config.mjs` 启用 standalone 输出**

Replace `next.config.mjs` with:
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
};

export default nextConfig;
```

- [ ] **Step 2: 创建 `.dockerignore`**

Create `.dockerignore`:
```
node_modules
.next
.git
docs
tests
*.md
.env*.local
```

- [ ] **Step 3: 创建 `Dockerfile`**

Create `Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 4: 构建镜像**

Run:
```bash
docker build -t rpg4pov:issue1 .
```
Expected: 三阶段构建成功，最终 `Successfully tagged rpg4pov:issue1`。

- [ ] **Step 5: 启动容器**

Run:
```bash
docker run --rm -d -p 3000:3000 --name rpg4pov-smoke rpg4pov:issue1
```
Expected: 输出容器 ID。等待约 3 秒让 server 启动。

- [ ] **Step 6: 验证首页可达**

Run:
```bash
curl -s -o /dev/null -w "%%{http_code}" http://localhost:3000/
```
Expected: `200`

- [ ] **Step 7: 验证占位 API 端到端**

Run:
```bash
curl -s -X POST http://localhost:3000/api/story-turn -H "content-type: application/json" -d "{\"input\":\"推开木门\"}"
```
Expected: JSON 包含 `{"playerResponse":"(占位回合 · tracer bullet)\n\n主角视窗：推开木门\n\n（这是占位响应，尚未接入故事引擎。）"}`

- [ ] **Step 8: 验证 400 路径**

Run:
```bash
curl -s -o /dev/null -w "%%{http_code}" -X POST http://localhost:3000/api/story-turn -H "content-type: application/json" -d "{\"input\":\"   \"}"
```
Expected: `400`

- [ ] **Step 9: 验证不暴露敏感文件（镜像内无 node_modules 全量、无源码）**

Run:
```bash
docker exec rpg4pov-smoke ls /app
```
Expected: 列表中存在 `server.js`、`.next`、`public`、`package.json`、`node_modules`（standalone 精简版），**不**存在 `src`、`tests`、`docs`、`.git`、`Dockerfile`。

- [ ] **Step 10: 停止并清理容器**

Run:
```bash
docker stop rpg4pov-smoke
```
Expected: 容器停止并被 `--rm` 自动移除。

- [ ] **Step 11: 提交**

```bash
git add .
git commit -m "feat(docker): standalone single-container image for web shell"
```

---

## Task 5: docker-compose 与 README

**Files:**
- Create: `docker-compose.yml`
- Create: `README.md`

- [ ] **Step 1: 创建 `docker-compose.yml`**

Create `docker-compose.yml`:
```yaml
services:
  rpg4pov:
    build: .
    image: rpg4pov:issue1
    container_name: rpg4pov
    ports:
      - "3000:3000"
    restart: unless-stopped
```

- [ ] **Step 2: 创建 `README.md`**

Create `README.md`:
```markdown
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
```

- [ ] **Step 3: 验证 compose 起容器**

Run:
```bash
docker compose up -d --build
```
Expected: 构建并启动，`docker compose ps` 显示 `running`。

Run:
```bash
curl -s -o /dev/null -w "%%{http_code}" http://localhost:3000/
```
Expected: `200`

- [ ] **Step 4: 清理**

Run:
```bash
docker compose down
```
Expected: 容器停止移除。

- [ ] **Step 5: 提交**

```bash
git add .
git commit -m "docs: add docker-compose and readme for web shell"
```

---

## 完成定义 (Definition of Done)

Issue 1 完成当且仅当：

1. `pnpm test` 全绿（API 契约：200/echo/400/坏 JSON）。
2. `pnpm build` 成功。
3. `docker build -t rpg4pov:issue1 .` 成功。
4. 容器内 `curl http://localhost:3000/` 返回 200。
5. 容器内 `POST /api/story-turn` 返回占位 `playerResponse` 且含输入文本。
6. 镜像内不含 `src`/`tests`/`docs`/`.git`/`Dockerfile`。
7. 浏览器人工确认：故事显示区 + 输入框 + 发送按钮 + loading 态 + 响应展示均正常。
8. 仓库已有 5 个提交（scaffold / api / ui / docker / docs），均在默认分支。

## Self-Review 已检查

- **Spec 覆盖**：极简 Web 页面 ✓（Task 1/3）、Next.js React 全栈壳 ✓（Task 1）、Docker 单容器仅暴露端口 ✓（Task 4/5）、占位故事回合 ✓（Task 2/3）、loading 一次性返回 ✓（Task 3）、不返回调试信息（API 仅 `playerResponse`/`error`）✓。
- **占位符扫描**：无 TBD/TODO，每步含完整代码或确切命令。
- **类型/命名一致**：`playerResponse`（route.ts、test、page.tsx、Docker 冒烟）一致；`POST` 签名一致；`@/` 别名在 tsconfig 与 vitest.config 均配置。
- **未越界**：无 storyId、无 workspace、无 agent、无随机、无锁、无回滚——均明确划归后续 issue。
