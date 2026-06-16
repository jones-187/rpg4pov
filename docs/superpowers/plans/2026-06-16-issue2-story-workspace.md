# Issue 2: 创建 storyId 并生成独立 Markdown Story Workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户能在首页创建新故事（可选标题），系统生成 storyId 并在该 storyId 下创建最小 Markdown Story Workspace 骨架；首页列出已有故事，点击进入该 storyId 的故事页；故事页发送输入时携带 storyId，后端校验 workspace 存在并仍返回占位响应；故事数据通过 Docker named volume 持久化，容器重建后不丢。

**Architecture:** 在 Issue 1 的 Next.js 全栈壳之上新增一层纯领域模块 `src/lib/workspace.ts`（唯一负责文件系统读写，所有路由通过它访问 workspace）。新增 `POST/GET /api/stories`、`GET /api/stories/{id}`；改造 `POST /api/story-turn` 为接收 `{storyId, input}`。Workspace 根目录由 `WORKSPACE_ROOT` 决定（prod `/app/data/workspaces`，dev `./data/workspaces`，测试注入 tmpdir）。**关键不变量：Web 只从 `turn/output.md` 读取主角可见输出**，不读 stdout / logs / world / player / actors；Issue 3 起仅替换 output.md 的写入者，读取路径固定不变。本 issue **不**做初始化 agent、Fake Agent turn、随机工具、真实故事推进、故事删除/重命名/搜索。

**Tech Stack:** Next.js 15（App Router）、React 19、TypeScript 5、pnpm 9、Node 20-alpine、Vitest 2。无新增依赖。

---

## Scope & Spec Coverage

依据 `docs/issue.md` Issue 2 与 `docs/arch-prd.md`。本计划覆盖：

- 生成 storyId（`crypto.randomUUID()`）— arch-prd P0-12/13、Decisions-24/25
- 每个 storyId 独立 Story Workspace，互相隔离 — arch-prd P0-13、US 8-10、Decisions-25
- Markdown-first 最小骨架，不留空目录 — arch-prd P0-9/10/11、Decisions-20/21/23
- storyId 接入故事页与 turn（携带 storyId，后端定位 workspace）— Issue 2 目标行为
- story turn 本 issue 仍返回占位响应（但经 turn/output.md 落盘并回读）— Issue 2 目标行为 + 用户约束 #1
- Web 只读 turn/output.md — arch-prd P0-18/19、Decisions-37/38/39、用户约束 #1
- 最小故事列表 + 创建 — Issue 2 明确范围
- Docker named volume 持久化，容器重建不丢 — arch-prd US 10、用户决策
- 非 root 用户对挂载卷的写权限 — arch-prd Decisions-6/7

**明确不做（属后续 issue）：** 初始化 agent（Issue 7）、Fake Agent 真实 turn（Issue 3）、随机工具（Issue 5）、串行锁/快照/回滚（Issue 4）、故事删除/重命名/搜索/归档/分享、真实故事内容生成、God State / NPC Memory（产品 PRD 后续 issue）。

## 锁定的实现决策

1. **storyId** = `crypto.randomUUID()`（UUID v4）。`isValidStoryId` 用 UUID v4 正则校验，天然防路径穿越，是隔离的硬保证。
2. **Workspace 布局**（最小骨架，Issue 7 init agent 会扩充真实内容）：
   ```
   {WORKSPACE_ROOT}/{storyId}/
     story.md        # front matter: id / title / createdAt + 占位正文
     rules.md        # 占位
     world.md        # 占位
     player.md       # 占位（主角）
     actors/.gitkeep # 占位 NPC 目录（后续 NPC 角色卡落这里）
     logs/.gitkeep   # 占位（后续 random log 落这里）
     turn/input.md   # 本回合主角输入落这里
     turn/output.md  # 本回合固定主角可见输出；Web 唯一返回源
   ```
3. **元数据存于 `story.md` 的 front matter**（`---\nkey: value\n---`），用一个 <20 行的无依赖解析器读取，保持 Markdown-first 同时可被 list/get 查询。
4. **标题** 创建时可选；空或缺失则存「未命名故事」（存归一化后的值）。
5. **`turn/output.md` 契约**：本 issue 的 turn 路由把占位响应写入 `turn/output.md` 再回读返回。从此刻起 Web 只读此文件。PRD 旧概念 `player-response.md` 在本项目统一落到 `turn/output.md`，不并存两个名字。
6. **WORKSPACE_ROOT**：prod `/app/data/workspaces`，dev 默认 `./data/workspaces`，测试用 tmpdir 注入。所有领域函数在**调用时**读 env（非模块加载时），保证测试注入有效。
7. **HTTP 语义**：`POST /api/stories` → 201；`GET /api/stories` → 200 `{stories:[...]}`；`GET /api/stories/{id}` 找不到/非法 id → 404；`POST /api/story-turn` 非法 body/input → 400，workspace 不存在 → 404。
8. **持久化 + 权限**：named volume 挂 `/app/data`；Dockerfile 在创建非 root 用户时一并 `mkdir -p /app/data/workspaces` 并 chown，使 named volume 首次挂载继承属主（规避非根用户写卷的经典坑）。

## File Structure

```
rpg4pov/
├── .gitignore                       # 改：加 data/
├── .dockerignore                    # 改：加 data
├── Dockerfile                       # 改：mkdir /app/data + chown + ENV WORKSPACE_ROOT
├── docker-compose.yml               # 改：named volume + image tag bump
├── README.md                        # 改：更新到 Issue 2 状态
├── src/
│   ├── lib/
│   │   └── workspace.ts             # 新：唯一文件系统领域模块
│   └── app/
│       ├── page.tsx                 # 改：首页 = 故事列表 + 创建表单
│       ├── globals.css              # 改：列表/链接/section 样式
│       ├── api/
│       │   ├── stories/
│       │   │   ├── route.ts         # 新：POST 建 / GET 列
│       │   │   └── [storyId]/
│       │   │       └── route.ts     # 新：GET 取单个
│       │   └── story-turn/
│       │       └── route.ts         # 改：收 {storyId,input}，只读 output.md
│       └── stories/
│           └── [storyId]/
│               └── page.tsx         # 新：故事页（知 storyId，发送时携带）
└── tests/
    ├── helpers/
    │   └── workspace-env.ts         # 新：tmpdir 注入 WORKSPACE_ROOT
    ├── lib/
    │   └── workspace.test.ts        # 新：骨架/解析/list/get/turn 读写 单元
    └── api/
        ├── stories.test.ts          # 新：建/列/取 契约
        └── story-turn.test.ts       # 改：新契约 + 只读 output.md 隔离
```

职责边界：
- `src/lib/workspace.ts` 是唯一触碰磁盘的模块；路由与 UI 都不直接 `fs`。
- 路由是薄包装：解析 body → 调领域函数 → 包 NextResponse。
- UI 只通过 `/api/stories*` 与 `/api/story-turn` 访问数据，不直接读磁盘。

---

## Task 1: Workspace 领域模块（TDD）

**Files:**
- Create: `tests/helpers/workspace-env.ts`
- Create: `tests/lib/workspace.test.ts`
- Create: `src/lib/workspace.ts`

- [ ] **Step 1: 创建测试 tmpdir 注入助手**

Create `tests/helpers/workspace-env.ts`:
```ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let savedRoot: string | undefined;

export async function useTempWorkspaceRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rpg4pov-ws-"));
  savedRoot = process.env.WORKSPACE_ROOT;
  const root = path.join(dir, "workspaces");
  await fs.mkdir(root, { recursive: true });
  process.env.WORKSPACE_ROOT = root;
  return root;
}

export function resetWorkspaceRoot(): void {
  if (savedRoot === undefined) {
    delete process.env.WORKSPACE_ROOT;
  } else {
    process.env.WORKSPACE_ROOT = savedRoot;
  }
}
```

- [ ] **Step 2: 写失败测试**

Create `tests/lib/workspace.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createStory,
  listStories,
  getStory,
  workspaceExists,
  isValidStoryId,
  readTurnOutput,
  writeTurnInput,
  writeTurnOutput,
  resolveWorkspaceRoot,
} from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("isValidStoryId", () => {
  it("accepts a UUID v4", () => {
    expect(isValidStoryId("11111111-1111-4111-8111-111111111111")).toBe(true);
  });
  it("rejects path traversal and non-uuid", () => {
    expect(isValidStoryId("..")).toBe(false);
    expect(isValidStoryId("a/b")).toBe(false);
    expect(isValidStoryId("not-a-uuid")).toBe(false);
    expect(isValidStoryId("")).toBe(false);
  });
});

describe("createStory", () => {
  it("returns meta with uuid id, normalized title and ISO createdAt", async () => {
    const meta = await createStory({ title: "  酒馆之夜  " });
    expect(UUID_RE.test(meta.storyId)).toBe(true);
    expect(meta.title).toBe("酒馆之夜");
    expect(() => new Date(meta.createdAt).toISOString()).not.toThrow();
    expect(new Date(meta.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("defaults title to 未命名故事", async () => {
    const meta = await createStory();
    expect(meta.title).toBe("未命名故事");
  });

  it("scaffolds all expected files (no empty dirs)", async () => {
    const meta = await createStory({ title: "骨架测试" });
    const dir = path.join(root, meta.storyId);
    const expected = [
      "story.md",
      "rules.md",
      "world.md",
      "player.md",
      "actors/.gitkeep",
      "logs/.gitkeep",
      "turn/input.md",
      "turn/output.md",
    ];
    for (const rel of expected) {
      await expect(fs.access(path.join(dir, rel))).resolves.toBeUndefined();
    }
  });

  it("writes id/title/createdAt into story.md front matter", async () => {
    const meta = await createStory({ title: "元数据测试" });
    const raw = await fs.readFile(path.join(root, meta.storyId, "story.md"), "utf8");
    expect(raw).toContain(`id: ${meta.storyId}`);
    expect(raw).toContain(`title: ${meta.title}`);
    expect(raw).toContain(`createdAt: ${meta.createdAt}`);
  });
});

describe("listStories", () => {
  it("lists created stories, newest first", async () => {
    await createStory({ title: "列表A" });
    const b = await createStory({ title: "列表B" });
    const list = await listStories();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].storyId).toBe(b.storyId); // newest first
    for (const m of list) expect(UUID_RE.test(m.storyId)).toBe(true);
  });

  it("returns [] when root is empty", async () => {
    const before = await listStories();
    expect(before.length).toBeGreaterThan(0); // 共享 tmpdir，此时非空
    // 隔离验证：指向一个空根
    process.env.WORKSPACE_ROOT = path.join(root, "does-not-exist");
    expect(await listStories()).toEqual([]);
    process.env.WORKSPACE_ROOT = root;
  });
});

describe("getStory / workspaceExists", () => {
  it("returns meta for existing, null for unknown/invalid", async () => {
    const meta = await createStory({ title: "查询测试" });
    expect(await getStory(meta.storyId)).toEqual(meta);
    expect(await getStory("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await getStory("../etc")).toBeNull();
  });
  it("workspaceExists mirrors getStory", async () => {
    const meta = await createStory();
    expect(await workspaceExists(meta.storyId)).toBe(true);
    expect(await workspaceExists("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(await workspaceExists("../etc")).toBe(false);
  });
});

describe("turn input/output files", () => {
  it("writes input and output, reads output back", async () => {
    const meta = await createStory();
    await writeTurnInput(meta.storyId, "推开木门");
    await writeTurnOutput(meta.storyId, "主角视窗内容");
    const out = await readTurnOutput(meta.storyId);
    expect(out).toBe("主角视窗内容");
    const inputRaw = await fs.readFile(
      path.join(root, meta.storyId, "turn", "input.md"),
      "utf8",
    );
    expect(inputRaw).toContain("推开木门");
  });
  it("readTurnOutput returns null for unknown story", async () => {
    expect(await readTurnOutput("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("resolveWorkspaceRoot", () => {
  it("resolves WORKSPACE_ROOT when set", () => {
    expect(resolveWorkspaceRoot()).toBe(path.resolve(root));
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run:
```bash
cd /d E:\projects\projects\rpg4pov
pnpm test
```
Expected: FAIL（`Cannot find module '@/lib/workspace'`）。

- [ ] **Step 4: 实现领域模块**

Create `src/lib/workspace.ts`:
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TITLE = "未命名故事";

export interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
}

export function resolveWorkspaceRoot(): string {
  const root = process.env.WORKSPACE_ROOT;
  if (root && root.trim()) return path.resolve(root);
  return path.resolve(process.cwd(), "data", "workspaces");
}

export function isValidStoryId(id: string): boolean {
  return STORY_ID_RE.test(id);
}

function workspaceDir(storyId: string): string {
  return path.resolve(resolveWorkspaceRoot(), storyId);
}

export async function workspaceExists(storyId: string): Promise<boolean> {
  if (!isValidStoryId(storyId)) return false;
  try {
    await fs.access(path.join(workspaceDir(storyId), "story.md"));
    return true;
  } catch {
    return false;
  }
}

export async function createStory(opts?: { title?: string }): Promise<StoryMeta> {
  const storyId = crypto.randomUUID();
  const title = normalizeTitle(opts?.title);
  const createdAt = new Date().toISOString();
  const dir = workspaceDir(storyId);

  await fs.mkdir(path.join(dir, "actors"), { recursive: true });
  await fs.mkdir(path.join(dir, "logs"), { recursive: true });
  await fs.mkdir(path.join(dir, "turn"), { recursive: true });

  await fs.writeFile(path.join(dir, "story.md"), storyMd(storyId, title, createdAt));
  await fs.writeFile(path.join(dir, "rules.md"), RULES_MD);
  await fs.writeFile(path.join(dir, "world.md"), WORLD_MD);
  await fs.writeFile(path.join(dir, "player.md"), PLAYER_MD);
  await fs.writeFile(path.join(dir, "actors", ".gitkeep"), "");
  await fs.writeFile(path.join(dir, "logs", ".gitkeep"), "");
  await fs.writeFile(path.join(dir, "turn", "input.md"), TURN_INPUT_PLACEHOLDER);
  await fs.writeFile(path.join(dir, "turn", "output.md"), TURN_OUTPUT_PLACEHOLDER);

  return { storyId, title, createdAt };
}

export async function listStories(): Promise<StoryMeta[]> {
  const root = resolveWorkspaceRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const metas: StoryMeta[] = [];
  for (const name of entries) {
    if (!isValidStoryId(name)) continue;
    const meta = await readStoryMeta(name);
    if (meta) metas.push(meta);
  }
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return metas;
}

export async function getStory(storyId: string): Promise<StoryMeta | null> {
  if (!isValidStoryId(storyId)) return null;
  return readStoryMeta(storyId);
}

async function readStoryMeta(storyId: string): Promise<StoryMeta | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir(storyId), "story.md"), "utf8");
    return parseStoryMd(raw);
  } catch {
    return null;
  }
}

export async function readTurnOutput(storyId: string): Promise<string | null> {
  if (!isValidStoryId(storyId)) return null;
  try {
    return await fs.readFile(path.join(workspaceDir(storyId), "turn", "output.md"), "utf8");
  } catch {
    return null;
  }
}

export async function writeTurnInput(storyId: string, input: string): Promise<void> {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  await fs.writeFile(
    path.join(workspaceDir(storyId), "turn", "input.md"),
    `# 本回合输入\n\n${input}\n`,
  );
}

export async function writeTurnOutput(storyId: string, content: string): Promise<void> {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  await fs.writeFile(path.join(workspaceDir(storyId), "turn", "output.md"), content);
}

function normalizeTitle(raw?: string): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  return t || DEFAULT_TITLE;
}

function parseStoryMd(raw: string): StoryMeta | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const map: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!map.id || !map.title || !map.createdAt) return null;
  return { storyId: map.id, title: map.title, createdAt: map.createdAt };
}

const RULES_MD = `# 规则\n\n（占位：故事运行规则。后续初始化 agent 填充，例如判定风格与随机权重约定。）\n`;
const WORLD_MD = `# 世界设定\n\n（占位：场景、地点、时间与隐藏事实。后续初始化 agent 填充。）\n`;
const PLAYER_MD = `# 主角\n\n（占位：主角角色卡与主角已知信息。后续初始化 agent 填充。）\n`;
const TURN_INPUT_PLACEHOLDER = `# 本回合输入\n\n（占位：主角本回合输入将写入这里。）\n`;
const TURN_OUTPUT_PLACEHOLDER = `# 本回合主角可见输出\n\n（占位：本回合固定主角可见输出。Web 只读取此文件返回用户。）\n`;

function storyMd(id: string, title: string, createdAt: string): string {
  return `---\nid: ${id}\ntitle: ${title}\ncreatedAt: ${createdAt}\n---\n\n# 故事\n\n（占位：故事元数据。真实设定由后续初始化 agent 填充。）\n`;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run:
```bash
pnpm test
```
Expected: `tests/lib/workspace.test.ts` 全部 PASS。

- [ ] **Step 6: 验证类型检查**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 7: 提交**

```bash
git add .
git commit -m "feat(workspace): markdown story workspace domain module"
```

---

## Task 2: stories API 路由（TDD）

**Files:**
- Create: `tests/api/stories.test.ts`
- Create: `src/app/api/stories/route.ts`
- Create: `src/app/api/stories/[storyId]/route.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/api/stories.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST as createStory, GET as listStories } from "@/app/api/stories/route";
import { GET as getStory } from "@/app/api/stories/[storyId]/route";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeAll(async () => {
  await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

function req(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/stories", () => {
  it("creates a story with given title → 201", async () => {
    const res = await createStory(req("http://localhost/api/stories", "POST", { title: "酒馆之夜" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(UUID_RE.test(json.storyId)).toBe(true);
    expect(json.title).toBe("酒馆之夜");
    expect(typeof json.createdAt).toBe("string");
  });

  it("defaults to 未命名故事 when title missing/blank", async () => {
    const res = await createStory(req("http://localhost/api/stories", "POST", { title: "   " }));
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("未命名故事");
  });

  it("creates with default title when body absent", async () => {
    const res = await createStory(req("http://localhost/api/stories", "POST"));
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("未命名故事");
  });
});

describe("GET /api/stories", () => {
  it("returns { stories: [...] } newest first", async () => {
    const res = await listStories();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.stories)).toBe(true);
    if (json.stories.length >= 2) {
      expect(json.stories[0].createdAt >= json.stories[1].createdAt).toBe(true);
    }
  });
});

describe("GET /api/stories/{id}", () => {
  it("returns 200 meta for existing story", async () => {
    const created = await createStory(req("http://localhost/api/stories", "POST", { title: "查询" }));
    const meta = await created.json();
    const res = await getStory(
      req(`http://localhost/api/stories/${meta.storyId}`, "GET"),
      { params: Promise.resolve({ storyId: meta.storyId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.storyId).toBe(meta.storyId);
    expect(json.title).toBe("查询");
  });

  it("returns 404 for unknown valid-format id", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const res = await getStory(req(`http://localhost/api/stories/${id}`, "GET"), {
      params: Promise.resolve({ storyId: id }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for invalid id", async () => {
    const res = await getStory(req("http://localhost/api/stories/../etc", "GET"), {
      params: Promise.resolve({ storyId: "../etc" }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm test tests/api/stories.test.ts
```
Expected: FAIL（`Cannot find module '@/app/api/stories/route'`）。

- [ ] **Step 3: 实现 `POST/GET /api/stories`**

Create `src/app/api/stories/route.ts`:
```ts
import { NextResponse } from "next/server";
import { createStory, listStories } from "@/lib/workspace";

// 创建故事。无必填字段：body 缺失或无 title 时创建「未命名故事」。
export async function POST(request: Request) {
  let title: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      const t = (body as { title?: unknown }).title;
      title = typeof t === "string" ? t : undefined;
    }
  } catch {
    // body 非 JSON：按无标题处理，仍允许创建。
  }
  const meta = await createStory({ title });
  return NextResponse.json(meta, { status: 201 });
}

export async function GET() {
  const stories = await listStories();
  return NextResponse.json({ stories });
}
```

- [ ] **Step 4: 实现 `GET /api/stories/{id}`**

Create `src/app/api/stories/[storyId]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { getStory } from "@/lib/workspace";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ storyId: string }> },
) {
  const { storyId } = await params;
  const meta = await getStory(storyId);
  if (!meta) {
    return NextResponse.json({ error: "story not found" }, { status: 404 });
  }
  return NextResponse.json(meta);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run:
```bash
pnpm test tests/api/stories.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 6: 验证生产构建**

Run:
```bash
pnpm build
```
Expected: 编译成功，`/api/stories` 与 `/api/stories/[storyId]` 作为路由出现。

- [ ] **Step 7: 提交**

```bash
git add .
git commit -m "feat(api): create/list/get story endpoints"
```

---

## Task 3: story-turn 接入 storyId，只读 turn/output.md（TDD，改现有测试）

**Files:**
- Modify: `tests/api/story-turn.test.ts`
- Modify: `src/app/api/story-turn/route.ts`

- [ ] **Step 1: 用新契约覆盖测试**

Replace the entire contents of `tests/api/story-turn.test.ts` with:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { POST } from "@/app/api/story-turn/route";
import { createStory, readTurnOutput, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

function req(body: unknown): Request {
  return new Request("http://localhost/api/story-turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function freshStory(): Promise<string> {
  const meta = await createStory({ title: "turn 测试" });
  return meta.storyId;
}

describe("POST /api/story-turn (Issue 2: storyId-bound, reads only turn/output.md)", () => {
  it("returns 200 and echoes input via turn/output.md", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "推开木门" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).toContain("推开木门");
    // 返回内容必须等于 turn/output.md 的落盘内容（Web 唯一来源）
    expect(json.playerResponse).toBe(await readTurnOutput(storyId));
  });

  it("writes player input to turn/input.md", async () => {
    const storyId = await freshStory();
    await POST(req({ storyId, input: "我走向酒馆门口" }));
    const raw = await fs.readFile(
      path.join(resolveWorkspaceRoot(), storyId, "turn", "input.md"),
      "utf8",
    );
    expect(raw).toContain("我走向酒馆门口");
  });

  it("returns 400 when input is missing/blank", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when storyId is invalid", async () => {
    const res = await POST(req({ storyId: "not-a-uuid", input: "x" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when workspace does not exist", async () => {
    const res = await POST(req({ storyId: "00000000-0000-4000-8000-000000000000", input: "x" }));
    expect(res.status).toBe(404);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const bad = new Request("http://localhost/api/story-turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });

  it("reads ONLY turn/output.md — junk in logs/ never leaks", async () => {
    const storyId = await freshStory();
    // 在 logs/ 写入「机密」，断言它不会出现在响应里
    await fs.writeFile(
      path.join(resolveWorkspaceRoot(), storyId, "logs", "secret.md"),
      "机密：主角不应看到的内容",
    );
    const res = await POST(req({ storyId, input: "试探" }));
    const json = await res.json();
    expect(json.playerResponse).not.toContain("机密");
    expect(json.playerResponse).toBe(await readTurnOutput(storyId));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm test tests/api/story-turn.test.ts
```
Expected: FAIL（现有路由不收 storyId，且不读 output.md）。

- [ ] **Step 3: 实现新路由**

Replace the entire contents of `src/app/api/story-turn/route.ts` with:
```ts
import { NextResponse } from "next/server";
import {
  isValidStoryId,
  workspaceExists,
  writeTurnInput,
  writeTurnOutput,
  readTurnOutput,
} from "@/lib/workspace";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const rawStoryId = (body as { storyId?: unknown }).storyId;
  const storyId = typeof rawStoryId === "string" ? rawStoryId.trim() : "";
  if (!isValidStoryId(storyId)) {
    return NextResponse.json({ error: "invalid storyId" }, { status: 400 });
  }

  const rawInput = (body as { input?: unknown }).input;
  const input = typeof rawInput === "string" ? rawInput.trim() : "";
  if (!input) {
    return NextResponse.json({ error: "input is required" }, { status: 400 });
  }

  if (!(await workspaceExists(storyId))) {
    return NextResponse.json({ error: "story not found" }, { status: 404 });
  }

  // Issue 2：仍为占位回合。
  // 关键不变量：Web 只从 turn/output.md 读取主角可见输出，
  // 不读 agent stdout / logs / world / player / actors。
  // Issue 3 起将替换 output.md 的写入者（fake agent），读取路径保持不变。
  await writeTurnInput(storyId, input);
  const placeholder = `(占位回合 · tracer bullet)\n\n主角视窗：${input}\n\n（这是占位响应，尚未接入故事引擎。）`;
  await writeTurnOutput(storyId, placeholder);
  const playerResponse = await readTurnOutput(storyId);

  if (!playerResponse) {
    return NextResponse.json({ error: "output unavailable" }, { status: 500 });
  }
  return NextResponse.json({ playerResponse });
}
```

- [ ] **Step 4: 运行全量测试确认通过**

Run:
```bash
pnpm test
```
Expected: 三个测试文件全部 PASS。

- [ ] **Step 5: 验证生产构建**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 6: 提交**

```bash
git add .
git commit -m "feat(api): bind story-turn to storyId and read only turn/output.md"
```

---

## Task 4: UI — 故事列表（首页）+ 故事页

**Files:**
- Modify: `src/app/page.tsx`（首页改为列表 + 创建表单）
- Create: `src/app/stories/[storyId]/page.tsx`
- Modify: `src/app/globals.css`（追加列表/链接/section 样式）

- [ ] **Step 1: 首页改为故事列表 + 创建表单**

Replace the entire contents of `src/app/page.tsx` with:
```tsx
"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
}

export default function HomePage() {
  const router = useRouter();
  const [stories, setStories] = useState<StoryMeta[]>([]);
  const [title, setTitle] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/stories");
      if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`);
      const data = (await res.json()) as { stories: StoryMeta[] };
      setStories(data.stories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`创建失败（HTTP ${res.status}）`);
      const meta = (await res.json()) as StoryMeta;
      router.push(`/stories/${meta.storyId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>小场景故事模拟</h1>

      <form onSubmit={handleCreate} className="input-form" aria-label="创建故事">
        <textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="故事标题（可选，留空为「未命名故事」）"
          rows={2}
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? "创建中…" : "创建新故事"}
        </button>
      </form>

      <section aria-label="故事列表">
        <h2 className="section-title">已有故事</h2>
        {stories.length === 0 ? (
          <p className="muted">还没有故事。创建一个开始吧。</p>
        ) : (
          <ul className="story-list">
            {stories.map((s) => (
              <li key={s.storyId}>
                <Link href={`/stories/${s.storyId}`} className="story-item">
                  <span className="story-item-title">{s.title}</span>
                  <span className="story-item-meta">{s.storyId.slice(0, 8)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 2: 创建故事页**

Create `src/app/stories/[storyId]/page.tsx`:
```tsx
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
}

export default function StoryPage() {
  const params = useParams<{ storyId: string }>();
  const storyId = params.storyId;

  const [title, setTitle] = useState<string>("");
  const [notFound, setNotFound] = useState<boolean>(false);
  const [narration, setNarration] = useState<string>(
    "故事已创建。在下方输入主角的第一回合行动，然后点击发送。"
  );
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/stories/${storyId}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`);
        const meta = (await res.json()) as StoryMeta;
        if (!cancelled) setTitle(meta.title);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "未知错误");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storyId]);

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
        body: JSON.stringify({ storyId, input: text }),
      });
      if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）`);
      const data = (await res.json()) as { playerResponse: string };
      setNarration(data.playerResponse);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }

  if (notFound) {
    return (
      <main className="container">
        <h1>故事不存在</h1>
        <p className="muted">找不到该 storyId。</p>
        <Link href="/" className="link">← 返回首页</Link>
      </main>
    );
  }

  return (
    <main className="container">
      <Link href="/" className="link">← 返回首页</Link>
      <h1>{title || "…"}</h1>
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

- [ ] **Step 3: 追加 CSS**

Append to `src/app/globals.css`:
```css
.section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--muted);
  margin: 0 0 8px;
}

.muted {
  color: var(--muted);
  font-size: 14px;
}

.link {
  color: var(--accent);
  font-size: 14px;
  text-decoration: none;
}

.story-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.story-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--panel);
  border-radius: 8px;
  padding: 12px 16px;
  text-decoration: none;
  color: var(--text);
}

.story-item:hover {
  background: #21252e;
}

.story-item-title {
  font-size: 15px;
}

.story-item-meta {
  font-size: 12px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

- [ ] **Step 4: 验证编译**

Run:
```bash
pnpm build
```
Expected: 编译成功，`/stories/[storyId]` 作为路由出现。

- [ ] **Step 5: 本地运行时冒烟（人工/可阻塞）**

Run:
```bash
pnpm dev
```
打开 `http://localhost:3000`：
- 首页显示创建表单 + 「已有故事」区（首次为空态文案）。
- 不填标题点「创建新故事」→ 跳转到故事页，标题显示「未命名故事」。
- 故事页输入「推开木门」点发送 → 故事区出现以 `(占位回合 · tracer bullet)` 开头、含「推开木门」的文本；按钮期间显示「处理中…」并禁用。
- 返回首页 → 「已有故事」列出刚创建的故事（标题 + id 前 8 位），点击可再次进入同一故事页。

确认后 `Ctrl+C` 停止 dev server。

- [ ] **Step 6: 提交**

```bash
git add .
git commit -m "feat(ui): story list home page and per-story page with storyId"
```

---

## Task 5: Docker 持久化（named volume + 非 root 写权限）

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Dockerfile 创建数据目录并赋权 + 注入 WORKSPACE_ROOT**

Edit `Dockerfile`，将 runner stage 的用户创建段：

```
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs
```

替换为：
```dockerfile
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && mkdir -p /app/data/workspaces \
 && chown -R nextjs:nodejs /app/data
```

并在 runner stage 的 ENV 区块（`ENV HOSTNAME=0.0.0.0` 之后）追加：
```dockerfile
ENV WORKSPACE_ROOT=/app/data/workspaces
```

- [ ] **Step 2: docker-compose 挂 named volume + bump image tag**

Replace the entire contents of `docker-compose.yml` with:
```yaml
services:
  rpg4pov:
    build: .
    image: rpg4pov:issue2
    container_name: rpg4pov
    ports:
      - "3000:3000"
    volumes:
      - rpg4pov-data:/app/data
    restart: unless-stopped

volumes:
  rpg4pov-data:
```

- [ ] **Step 3: 构建镜像**

Run:
```bash
cd /d E:\projects\projects\rpg4pov
docker build -t rpg4pov:issue2 .
```
Expected: 三阶段构建成功。

- [ ] **Step 4: 起容器并验证基础可达**

Run:
```bash
docker run --rm -d -p 3000:3000 --name rpg4pov-smoke rpg4pov:issue2
```
等待约 3 秒后：
```bash
curl -s -o /dev/null -w "%%{http_code}" http://localhost:3000/
```
Expected: `200`

- [ ] **Step 5: 验证创建 + 列表 + 取单个 + 占位 turn（端到端）**

Run（创建）：
```bash
curl -s -X POST http://localhost:3000/api/stories -H "content-type: application/json" -d "{\"title\":\"酒馆之夜\"}"
```
Expected: 201，JSON 含 `storyId`（UUID）、`title:"酒馆之夜"`、`createdAt`。

从返回里复制 `storyId`，替换下方 `<ID>` 后运行：
```bash
curl -s http://localhost:3000/api/stories
```
Expected: JSON `{ "stories": [ { ... title:"酒馆之夜" ... } ] }。

```bash
curl -s http://localhost:3000/api/stories/<ID>
```
Expected: 200，meta 与上一步一致。

```bash
curl -s -o /dev/null -w "%%{http_code}" http://localhost:3000/api/stories/00000000-0000-4000-8000-000000000000
```
Expected: `404`

```bash
curl -s -X POST http://localhost:3000/api/story-turn -H "content-type: application/json" -d "{\"storyId\":\"<ID>\",\"input\":\"推开木门\"}"
```
Expected: JSON `{"playerResponse":"(占位回合 · tracer bullet)\n\n主角视窗：推开木门\n\n（这是占位响应，尚未接入故事引擎。）"}`

- [ ] **Step 6: 验证非 root 用户可写卷 + 持久化（容器内写入路径）**

```bash
docker exec rpg4pov-smoke sh -c "ls -ld /app/data/workspaces && find /app/data/workspaces -name story.md | head -1"
```
Expected: `/app/data/workspaces` 存在且属主可写；存在至少一个 `<storyId>/story.md`（由上一步创建写入，证明非 root 进程能写卷）。

```bash
docker stop rpg4pov-smoke
```

- [ ] **Step 7: 用 compose 验证 named volume 跨容器重建持久化**

Run:
```bash
docker compose up -d --build
```
打开浏览器 `http://localhost:3000`：点「创建新故事」（标题「持久化测试」）→ 进入故事页 → 返回首页确认列表含该故事。

Run（仅停容器，**不带 -v**，保留卷）：
```bash
docker compose down
```
Run（重建容器）：
```bash
docker compose up -d --build
```
打开 `http://localhost:3000`：「已有故事」中「持久化测试」仍然存在 → 卷持久化成立。

Run：
```bash
curl -s http://localhost:3000/api/stories
```
Expected: JSON 仍含 title 为「持久化测试」（及「酒馆之夜」，若未清镜像/卷）的故事。

- [ ] **Step 8: 清理**

Run:
```bash
docker compose down
```
Expected: 容器停止移除（named volume 保留，供后续开发继续使用）。

- [ ] **Step 9: 提交**

```bash
git add .
git commit -m "feat(docker): persist story workspaces via named volume"
```

---

## Task 6: README / .gitignore / .dockerignore + 最终 DoD 验证

**Files:**
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Modify: `README.md`

- [ ] **Step 1: `.gitignore` 排除 dev workspace 数据**

在 `.gitignore` 的 `# misc` 段上方追加：
```
# story workspace data (dev)
data
```

- [ ] **Step 2: `.dockerignore` 排除 dev workspace 数据**

在 `.dockerignore` 中追加一行：
```
data
```

- [ ] **Step 3: 更新 README 到 Issue 2 状态**

Replace the entire contents of `README.md` with:
```markdown
# rpg4pov

小场景、多角色、主角视角受限的 AI 故事模拟引擎。

当前仓库状态：**Issue 2 — storyId + 独立 Markdown Story Workspace**。
首页可创建/列出故事，进入故事页发送主角输入；后端按 storyId 定位独立 workspace，返回占位回合。
尚未接入初始化 agent、真实 agent runtime 与随机工具（属后续 issue）。

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
  logs/.gitkeep    # 占位（random log 目录）
  turn/input.md    # 本回合主角输入
  turn/output.md   # 本回合固定主角可见输出（Web 唯一返回源）
```

主角可见输出只来自 `turn/output.md`；Web 不读取 agent stdout、logs、world、player、actors。
```

- [ ] **Step 4: 最终全量验证**

Run:
```bash
pnpm test
```
Expected: 三个测试文件全部 PASS。

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 5: 提交**

```bash
git add .
git commit -m "docs: update readme and ignore dev workspace data"
```

---

## 完成定义 (Definition of Done)

Issue 2 完成当且仅当：

1. `pnpm test` 全绿（`tests/lib/workspace.test.ts` + `tests/api/stories.test.ts` + `tests/api/story-turn.test.ts`）。
2. `pnpm build` 成功，路由含 `/api/stories`、`/api/stories/[storyId]`、`/stories/[storyId]`。
3. `createStory` 后 workspace 含全部 8 个文件/占位项（无空目录），`story.md` front matter 含 id/title/createdAt。
4. 不同 storyId 的 workspace 物理隔离（路径 `{WORKSPACE_ROOT}/{storyId}/`，storyId 强制 UUID v4）。
5. `POST /api/story-turn` 必须 `{storyId, input}`：非法 storyId → 400；workspace 不存在 → 404；成功时响应内容**等于** `turn/output.md` 落盘内容（Web 唯一来源），且 logs 等内部文件不泄漏。
6. 首页能列出已有故事（newest first）+ 创建；故事页知 storyId，发送携带 storyId。
7. `docker build -t rpg4pov:issue2 .` 成功；容器内非 root 进程能写 `/app/data/workspaces`。
8. named volume 持久化：`compose down`（不带 -v）→ `compose up` 后已创建故事仍在。
9. 镜像内不含 `src`/`tests`/`docs`/`.git`/`Dockerfile`/`data`。
10. 仓库提交序列清晰：workspace 模块 / stories API / story-turn 改造 / UI / docker 持久化 / docs。

## Self-Review 已检查

- **Spec 覆盖**：storyId 生成 ✓（Task1）、独立隔离 workspace ✓（Task1/3）、Markdown 最小骨架不留空目录 ✓（Task1）、storyId 接入故事页与 turn ✓（Task3/4）、占位回合经 output.md 落盘回读 ✓（Task3）、Web 只读 turn/output.md ✓（Task3 测试 + Task5 端到端）、最小列表+创建 ✓（Task4）、Docker named volume 持久化 ✓（Task5）、非 root 写权限 ✓（Task5）。
- **未越界**：无初始化 agent、无 Fake Agent 真实 turn、无随机工具、无串行锁/快照/回滚、无故事删除/重命名/搜索、无真实故事内容生成——均划归后续 issue。
- **占位符扫描**：无 TBD/TODO，每步含完整代码或确切命令；`<ID>` 占位出现在明确需用户从上一步复制之处。
- **类型/命名一致**：`StoryMeta{storyId,title,createdAt}`、`playerResponse`、`turn/output.md`、`WORKSPACE_ROOT` 在模块/路由/测试/UI/Docker 全链路一致；`@/` 别名沿用 Issue 1。
- **约束 #1 落实**：turn 路由先 `writeTurnOutput` 再 `readTurnOutput`，并有专门的「logs 机密不泄漏」测试钉死读取边界；旧 `player-response.md` 概念统一为 `turn/output.md`，无第二个名字。
- **Next 15 适配**：动态路由 `[storyId]` 的 `params` 按 `Promise` 处理；客户端页用 `useParams`/`useRouter`。
```
