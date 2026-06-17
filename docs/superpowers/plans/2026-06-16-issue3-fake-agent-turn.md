# Issue 3: 用 Fake Agent 跑通单回合 Story Turn 闭环 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在故事页输入内容后，系统通过 Agent Runtime Adapter 调用 Fake Agent Runner 完成一个回合，Fake Agent 写入固定主角可见输出和成功标记，后端只从 turn/output.md 读取并返回页面。

**Architecture:** 在 Issue 2 的 workspace.ts 之上新增三个模块：`agent-runner.ts`（AgentRunner 接口 + TurnRequest/TurnResult 类型）、`fake-agent-runner.ts`（Fake Agent 实现）、`turn-orchestrator.ts`（回合编排器）。TurnOrchestrator 构造时注入 AgentRunner，编排"清理旧 done.json → 写 input → 调 runner → 检查磁盘 done.json → 读 output.md"流程。Runner 直接在 workspaceDir 内用 fs 写 output.md 和 done.json，Orchestrator 通过 workspace.ts 读取。story-turn/route.ts 退化为薄层，只做 HTTP 解析 + 调 orchestrator + 包 NextResponse。**关键不变量：Web 返回内容只能来自 turn/output.md，不读 stdout/logs/world/player/actors。** Issue 3 不做 timeout、snapshot、rollback——runner 异常或 done/output 缺失时返回受控失败响应。

**Tech Stack:** Next.js 15（App Router）、React 19、TypeScript 5、pnpm 9、Node 20-alpine、Vitest 2。无新增依赖。

---

## Scope & Spec Coverage

依据 `docs/issue.md` Issue 3、`docs/arch-prd.md`、`docs/superpowers/grills/2026-06-16-issue3-fake-agent-turn.md`。本计划覆盖：

- Agent Runtime Adapter（AgentRunner 接口）— arch-prd P0-5、Decisions-12/19
- Fake Agent Runner — Issue 3 目标行为
- Turn Orchestrator 编排回合生命周期 — arch-prd Decisions-3
- Runner 直接写 workspace（output.md + done.json）— arch-prd P0-15、Decisions-31
- Web 只读 turn/output.md — arch-prd P0-18/19、Decisions-37/38/39
- 运行成功标记 turn/done.json — arch-prd P0-11
- 每回合冷启动 — arch-prd P0-14、Decisions-29
- 回合成功条件：done.json 存在且 status=success + output.md 存在且非空 — 用户约束 #1
- 受控失败响应（不 500 崩溃）— 用户约束 #2
- done.json 不在骨架中，回合前清理 — 用户约束 #3

**明确不做（属后续 issue）：** timeout（Issue 4）、snapshot/rollback（Issue 4）、串行锁（Issue 4）、随机工具（Issue 5）、真实 agent（Issue 6）、故事初始化 agent（Issue 7）。

## 锁定的实现决策

1. **AgentRunner 接口**：`runTurn(req: TurnRequest): Promise<TurnResult>`，TurnResult 只含 `{ success: boolean; error?: string }`。Runner 写文件，不返回内容。
2. **TurnRequest**：`{ storyId, workspaceDir, playerInput }`。workspaceDir 是绝对路径，playerInput 是便利字段。
3. **TurnOrchestrator**：类，构造时注入 AgentRunner。`executeTurn(storyId, playerInput): Promise<TurnOutcome>`。
4. **TurnOutcome**：`{ success: boolean; playerResponse: string | null; error?: string }`。playerResponse 从 turn/output.md 读取。
5. **done.json**：`{ "status": "success", "completedAt": "ISO" }`。不在 createStory 骨架中。回合前清理，runner 成功后才写。
6. **回合成功条件**：done.json 存在且 status=success **且** output.md 存在且内容非空。
7. **磁盘权威**：Orchestrator 以 done.json + output.md 磁盘状态为权威，不信任 runner 返回值。
8. **异常处理**：Orchestrator catch runner 异常，转为 `{ success: false }`，统一走磁盘检查。
9. **文件访问边界**：workspace.ts = Web 侧唯一磁盘入口（读 + 生命周期管理）；AgentRunner = 在 workspaceDir 内直接 fs 写。
10. **删除 writeTurnOutput**：Issue 3 后 runner 直接 fs 写 output.md，orchestrator 不再调用 writeTurnOutput。

## File Structure

```
rpg4pov/
├── src/
│   ├── lib/
│   │   ├── workspace.ts              # 改：新增 readTurnDone/clearTurnDone/resolveWorkspaceDir/DoneMarker，删 writeTurnOutput
│   │   ├── agent-runner.ts           # 新：AgentRunner 接口 + TurnRequest/TurnResult 类型
│   │   ├── fake-agent-runner.ts      # 新：FakeAgentRunner 实现
│   │   └── turn-orchestrator.ts      # 新：TurnOrchestrator + TurnOutcome 类型
│   └── app/
│       └── api/
│           └── story-turn/
│               └── route.ts          # 改：薄层，调 TurnOrchestrator
└── tests/
    ├── lib/
    │   ├── workspace.test.ts         # 改：加 done.json 相关测试，删 writeTurnOutput 测试
    │   ├── fake-agent-runner.test.ts  # 新
    │   └── turn-orchestrator.test.ts  # 新
    └── api/
        └── story-turn.test.ts        # 不改（API 契约不变，自动适配新架构）
```

职责边界：
- `workspace.ts`：Web 侧对 workspace 的唯一访问入口（读 + 生命周期管理）。
- `agent-runner.ts`：纯类型定义，无运行时逻辑。
- `fake-agent-runner.ts`：在 workspaceDir 内直接 fs 写 output.md + done.json。
- `turn-orchestrator.ts`：编排回合生命周期，不直接 fs，通过 workspace.ts 读写。
- `story-turn/route.ts`：HTTP 解析 + 调 orchestrator + 包 NextResponse。

---

## Task 1: workspace.ts 新增 done.json 相关函数（TDD）

**Files:**
- Modify: `tests/lib/workspace.test.ts`
- Modify: `src/lib/workspace.ts`

- [ ] **Step 1: 在 workspace.test.ts 追加 done.json 相关测试**

在 `tests/lib/workspace.test.ts` 的 `describe("turn input/output files", ...)` 块之后追加以下内容。同时更新该 describe 块的标题为 `turn input/output/done files`，并在其中已有的 `readTurnOutput returns null for unknown story` 测试后追加 done 相关测试。

将 `tests/lib/workspace.test.ts` 中 `describe("turn input/output files", ...)` 整块替换为：

```ts
describe("turn input/output/done files", () => {
  it("writes input and reads output back", async () => {
    const meta = await createStory();
    await writeTurnInput(meta.storyId, "推开木门");
    // 模拟 runner 直接写 output.md（Issue 3 起 runner 用 fs 写）
    await fs.writeFile(
      path.join(root, meta.storyId, "turn", "output.md"),
      "主角视窗内容",
    );
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

  it("readTurnDone returns null when done.json does not exist", async () => {
    const meta = await createStory();
    expect(await readTurnDone(meta.storyId)).toBeNull();
  });
  it("readTurnDone returns parsed marker when done.json exists", async () => {
    const meta = await createStory();
    await fs.writeFile(
      path.join(root, meta.storyId, "turn", "done.json"),
      JSON.stringify({ status: "success", completedAt: "2026-06-16T12:00:00.000Z" }),
    );
    const done = await readTurnDone(meta.storyId);
    expect(done).toEqual({ status: "success", completedAt: "2026-06-16T12:00:00.000Z" });
  });
  it("readTurnDone returns null for invalid JSON", async () => {
    const meta = await createStory();
    await fs.writeFile(
      path.join(root, meta.storyId, "turn", "done.json"),
      "not-json",
    );
    expect(await readTurnDone(meta.storyId)).toBeNull();
  });
  it("readTurnDone returns null when fields are missing", async () => {
    const meta = await createStory();
    await fs.writeFile(
      path.join(root, meta.storyId, "turn", "done.json"),
      JSON.stringify({ status: "success" }),
    );
    expect(await readTurnDone(meta.storyId)).toBeNull();
  });
  it("readTurnDone returns null for unknown story", async () => {
    expect(await readTurnDone("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("clearTurnDone removes done.json if exists", async () => {
    const meta = await createStory();
    const donePath = path.join(root, meta.storyId, "turn", "done.json");
    await fs.writeFile(donePath, JSON.stringify({ status: "success", completedAt: "2026-06-16T12:00:00.000Z" }));
    await clearTurnDone(meta.storyId);
    await expect(fs.access(donePath)).rejects.toThrow();
  });
  it("clearTurnDone is no-op when done.json does not exist", async () => {
    const meta = await createStory();
    await expect(clearTurnDone(meta.storyId)).resolves.toBeUndefined();
  });
});

describe("resolveWorkspaceDir", () => {
  it("returns absolute path for valid storyId", async () => {
    const meta = await createStory();
    expect(resolveWorkspaceDir(meta.storyId)).toBe(path.resolve(root, meta.storyId));
  });
  it("throws for invalid storyId", () => {
    expect(() => resolveWorkspaceDir("..")).toThrow("invalid storyId");
    expect(() => resolveWorkspaceDir("not-a-uuid")).toThrow("invalid storyId");
    expect(() => resolveWorkspaceDir("")).toThrow("invalid storyId");
  });
});
```

同时更新文件顶部的 import，将：
```ts
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
```
替换为：
```ts
import {
  createStory,
  listStories,
  getStory,
  workspaceExists,
  isValidStoryId,
  readTurnOutput,
  readTurnDone,
  clearTurnDone,
  writeTurnInput,
  resolveWorkspaceDir,
  resolveWorkspaceRoot,
} from "@/lib/workspace";
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm test tests/lib/workspace.test.ts
```
Expected: FAIL（`readTurnDone` / `clearTurnDone` / `resolveWorkspaceDir` 未导出）。

- [ ] **Step 3: 在 workspace.ts 中实现新函数**

在 `src/lib/workspace.ts` 中，`StoryMeta` 接口之后追加 `DoneMarker` 接口：

```ts
export interface DoneMarker {
  status: string;
  completedAt: string;
}
```

将私有函数 `workspaceDir` 改为公开函数 `resolveWorkspaceDir`（含校验），替换原来的 `workspaceDir` 函数：

```ts
export function resolveWorkspaceDir(storyId: string): string {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  return path.resolve(resolveWorkspaceRoot(), storyId);
}
```

将文件中所有对 `workspaceDir(...)` 的调用替换为 `resolveWorkspaceDir(...)`。涉及以下函数：`workspaceExists`、`createStory`、`readStoryMeta`、`readTurnOutput`、`writeTurnInput`、`writeTurnOutput`。

在 `writeTurnInput` 函数之后追加 `readTurnDone` 和 `clearTurnDone`：

```ts
export async function readTurnDone(storyId: string): Promise<DoneMarker | null> {
  if (!isValidStoryId(storyId)) return null;
  try {
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(storyId), "turn", "done.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as DoneMarker).status !== "string" ||
      typeof (parsed as DoneMarker).completedAt !== "string"
    ) {
      return null;
    }
    return parsed as DoneMarker;
  } catch {
    return null;
  }
}

export async function clearTurnDone(storyId: string): Promise<void> {
  if (!isValidStoryId(storyId)) return;
  try {
    await fs.unlink(path.join(resolveWorkspaceDir(storyId), "turn", "done.json"));
  } catch {
    // 文件不存在，无需操作
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm test tests/lib/workspace.test.ts
```
Expected: 全部 PASS（包括新增的 done.json 测试和 resolveWorkspaceDir 测试）。

- [ ] **Step 5: 验证类型检查**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 6: 提交**

```bash
git add tests/lib/workspace.test.ts src/lib/workspace.ts
git commit -m "feat(workspace): add done.json read/clear and resolveWorkspaceDir"
```

---

## Task 2: AgentRunner 接口定义

**Files:**
- Create: `src/lib/agent-runner.ts`

- [ ] **Step 1: 创建 agent-runner.ts**

Create `src/lib/agent-runner.ts`:
```ts
/**
 * Agent Runtime Adapter 的稳定边界。
 * Web/API 层只依赖此接口，不感知具体 runner 实现。
 * Runner 在 workspaceDir 内直接写文件（output.md + done.json），
 * 不通过返回值传递内容——Web 只从 turn/output.md 读取主角可见输出。
 */

/** 传给 AgentRunner 的回合请求 */
export interface TurnRequest {
  /** 故事 ID（UUID v4） */
  storyId: string;
  /** workspace 绝对路径，runner 在此目录内读写 */
  workspaceDir: string;
  /** 主角本回合输入（与 turn/input.md 内容一致，便利字段） */
  playerInput: string;
}

/** AgentRunner 返回的回合结果（不含内容，内容写文件） */
export interface TurnResult {
  /** runner 声明是否成功（Orchestrator 以磁盘 done.json 为权威） */
  success: boolean;
  /** 失败时的内部诊断信息 */
  error?: string;
}

/**
 * Agent Runtime Adapter 接口。
 * 实现方在 runTurn 内：
 * 1. 读取 workspace 当前状态（含 turn/input.md）
 * 2. 写 turn/output.md（固定主角可见输出）
 * 3. 写 turn/done.json（成功标记）
 * 4. 返回 { success: true }
 * 失败时返回 { success: false, error } 或抛异常（由 Orchestrator 捕获）。
 */
export interface AgentRunner {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
```

- [ ] **Step 2: 验证类型检查**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 3: 提交**

```bash
git add src/lib/agent-runner.ts
git commit -m "feat(agent): define AgentRunner interface and types"
```

---

## Task 3: FakeAgentRunner 实现（TDD）

**Files:**
- Create: `tests/lib/fake-agent-runner.test.ts`
- Create: `src/lib/fake-agent-runner.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/lib/fake-agent-runner.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import { createStory, resolveWorkspaceDir, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("FakeAgentRunner", () => {
  it("writes turn/output.md containing the player input", async () => {
    const meta = await createStory({ title: "fake agent 测试" });
    const runner = new FakeAgentRunner();
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
    });
    const output = await fs.readFile(
      path.join(root, meta.storyId, "turn", "output.md"),
      "utf8",
    );
    expect(output).toContain("推开木门");
    expect(output).toContain("主角视窗");
  });

  it("writes turn/done.json with status=success and ISO completedAt", async () => {
    const meta = await createStory();
    const runner = new FakeAgentRunner();
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "观察四周",
    });
    const raw = await fs.readFile(
      path.join(root, meta.storyId, "turn", "done.json"),
      "utf8",
    );
    const done = JSON.parse(raw);
    expect(done.status).toBe("success");
    expect(() => new Date(done.completedAt).toISOString()).not.toThrow();
  });

  it("returns { success: true }", async () => {
    const meta = await createStory();
    const runner = new FakeAgentRunner();
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "试探",
    });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("does not touch logs/ or world.md or player.md", async () => {
    const meta = await createStory();
    const before = await fs.readFile(
      path.join(root, meta.storyId, "world.md"),
      "utf8",
    );
    const runner = new FakeAgentRunner();
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "不动",
    });
    const after = await fs.readFile(
      path.join(root, meta.storyId, "world.md"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm test tests/lib/fake-agent-runner.test.ts
```
Expected: FAIL（`Cannot find module '@/lib/fake-agent-runner'`）。

- [ ] **Step 3: 实现 FakeAgentRunner**

Create `src/lib/fake-agent-runner.ts`:
```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";

/**
 * Fake Agent Runner — Issue 3 验证用实现。
 * 不接入真实大模型，读取 playerInput 后生成固定格式输出。
 * 只写 turn/output.md 和 turn/done.json，不碰其他 workspace 文件。
 * 是临时验证组件，非永久产品运行时。
 */
export class FakeAgentRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const turnDir = path.join(req.workspaceDir, "turn");

    const output = [
      "# 主角视窗",
      "",
      "（Fake Agent 固定输出）",
      "",
      `你选择了：${req.playerInput}`,
      "",
      "周围一切安静。没有特别的事情发生。",
      "",
    ].join("\n");

    await fs.writeFile(path.join(turnDir, "output.md"), output);
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({
        status: "success",
        completedAt: new Date().toISOString(),
      }),
    );

    return { success: true };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm test tests/lib/fake-agent-runner.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 5: 验证类型检查**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 6: 提交**

```bash
git add tests/lib/fake-agent-runner.test.ts src/lib/fake-agent-runner.ts
git commit -m "feat(agent): implement FakeAgentRunner"
```

---

## Task 4: TurnOrchestrator 实现（TDD）

**Files:**
- Create: `tests/lib/turn-orchestrator.test.ts`
- Create: `src/lib/turn-orchestrator.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/lib/turn-orchestrator.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import type { AgentRunner, TurnRequest, TurnResult } from "@/lib/agent-runner";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import {
  createStory,
  readTurnDone,
  readTurnOutput,
  resolveWorkspaceDir,
  resolveWorkspaceRoot,
} from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

// --- 测试用 runner ---

/** 抛异常的 runner */
class CrashingRunner implements AgentRunner {
  async runTurn(): Promise<TurnResult> {
    throw new Error("boom");
  }
}

/** 什么都不做的 runner（不写 done.json） */
class NoopRunner implements AgentRunner {
  async runTurn(): Promise<TurnResult> {
    return { success: false, error: "did nothing" };
  }
}

/** 写 done.json 但 output.md 为空的 runner */
class EmptyOutputRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const turnDir = path.join(req.workspaceDir, "turn");
    await fs.writeFile(path.join(turnDir, "output.md"), "");
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    return { success: true };
  }
}

// --- 测试 ---

describe("TurnOrchestrator", () => {
  it("success: FakeAgentRunner → returns playerResponse from output.md", async () => {
    const meta = await createStory({ title: "orchestrator 成功" });
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "推开木门");
    expect(outcome.success).toBe(true);
    expect(outcome.playerResponse).not.toBeNull();
    expect(outcome.playerResponse).toContain("推开木门");
    // 返回内容必须等于 turn/output.md 落盘内容
    expect(outcome.playerResponse).toBe(await readTurnOutput(meta.storyId));
  });

  it("success: done.json exists with status=success after turn", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    await orchestrator.executeTurn(meta.storyId, "观察");
    const done = await readTurnDone(meta.storyId);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("success");
  });

  it("runner crash: returns failure, does not throw", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new CrashingRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
    expect(outcome.success).toBe(false);
    expect(outcome.playerResponse).toBeNull();
    expect(outcome.error).toBeDefined();
  });

  it("missing done.json: returns failure", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new NoopRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "等待");
    expect(outcome.success).toBe(false);
    expect(outcome.playerResponse).toBeNull();
  });

  it("empty output.md: returns failure even if done.json exists", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new EmptyOutputRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "沉默");
    expect(outcome.success).toBe(false);
    expect(outcome.playerResponse).toBeNull();
  });

  it("clears old done.json before calling runner", async () => {
    const meta = await createStory();
    // 手动写入旧 done.json
    const donePath = path.join(root, meta.storyId, "turn", "done.json");
    await fs.writeFile(
      donePath,
      JSON.stringify({ status: "success", completedAt: "2000-01-01T00:00:00.000Z" }),
    );
    // 用 NoopRunner（不写 done.json），验证旧 done.json 被清理
    const orchestrator = new TurnOrchestrator(new NoopRunner());
    await orchestrator.executeTurn(meta.storyId, "测试");
    await expect(fs.access(donePath)).rejects.toThrow();
  });

  it("writes player input to turn/input.md before calling runner", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    await orchestrator.executeTurn(meta.storyId, "走向酒馆");
    const inputRaw = await fs.readFile(
      path.join(root, meta.storyId, "turn", "input.md"),
      "utf8",
    );
    expect(inputRaw).toContain("走向酒馆");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm test tests/lib/turn-orchestrator.test.ts
```
Expected: FAIL（`Cannot find module '@/lib/turn-orchestrator'`）。

- [ ] **Step 3: 实现 TurnOrchestrator**

Create `src/lib/turn-orchestrator.ts`:
```ts
import type { AgentRunner, TurnResult } from "./agent-runner";
import {
  clearTurnDone,
  readTurnDone,
  readTurnOutput,
  resolveWorkspaceDir,
  writeTurnInput,
} from "./workspace";

/**
 * 回合编排结果。Orchestrator → Route。
 * playerResponse 从 turn/output.md 读取，不是 runner 返回值。
 */
export interface TurnOutcome {
  success: boolean;
  playerResponse: string | null;
  error?: string;
}

/**
 * 回合生命周期编排器。
 * 持有 AgentRunner 实例，对回合内的所有失败负责。
 * 不直接 fs，通过 workspace.ts 读写。
 */
export class TurnOrchestrator {
  constructor(private runner: AgentRunner) {}

  async executeTurn(storyId: string, playerInput: string): Promise<TurnOutcome> {
    // 1. 清理上回合 done.json
    await clearTurnDone(storyId);

    // 2. 写入主角输入
    await writeTurnInput(storyId, playerInput);

    // 3. 获取 workspace 绝对路径，构造请求
    const workspaceDir = resolveWorkspaceDir(storyId);
    const req = { storyId, workspaceDir, playerInput };

    // 4. 调用 runner（捕获异常，转为失败）
    let result: TurnResult;
    try {
      result = await this.runner.runTurn(req);
    } catch {
      result = { success: false, error: "runner crashed" };
    }

    // 5. 检查磁盘权威状态：done.json 必须存在且 status=success
    const done = await readTurnDone(storyId);
    if (!done || done.status !== "success") {
      return {
        success: false,
        playerResponse: null,
        error: result.error ?? "done marker missing",
      };
    }

    // 6. 检查 output.md 必须存在且非空
    const playerResponse = await readTurnOutput(storyId);
    if (!playerResponse || playerResponse.trim() === "") {
      return {
        success: false,
        playerResponse: null,
        error: "output missing or empty",
      };
    }

    // 7. 成功：返回从文件读取的主角可见输出
    return { success: true, playerResponse };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm test tests/lib/turn-orchestrator.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 5: 验证类型检查**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 6: 提交**

```bash
git add tests/lib/turn-orchestrator.test.ts src/lib/turn-orchestrator.ts
git commit -m "feat(orchestrator): implement TurnOrchestrator with disk-authoritative checks"
```

---

## Task 5: story-turn/route.ts 改造 + 删除 writeTurnOutput（TDD）

**Files:**
- Modify: `src/app/api/story-turn/route.ts`
- Modify: `src/lib/workspace.ts`（删除 writeTurnOutput）
- Modify: `tests/lib/workspace.test.ts`（已不含 writeTurnOutput 引用）

- [ ] **Step 1: 改造 route.ts 为薄层**

Replace the entire contents of `src/app/api/story-turn/route.ts` with:
```ts
import { NextResponse } from "next/server";
import { isValidStoryId, workspaceExists } from "@/lib/workspace";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";

// 模块级单例：runner 在应用生命周期内不变
const orchestrator = new TurnOrchestrator(new FakeAgentRunner());

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

  // Issue 3：通过 TurnOrchestrator + FakeAgentRunner 执行回合。
  // 关键不变量：Web 只从 turn/output.md 读取主角可见输出，
  // 不读 agent stdout / logs / world / player / actors。
  // 失败时返回受控响应，不让 route 直接 500 崩溃。
  // timeout / snapshot / rollback 留给 Issue 4。
  const outcome = await orchestrator.executeTurn(storyId, input);
  if (!outcome.success || !outcome.playerResponse) {
    return NextResponse.json(
      { error: "回合执行失败，请重试" },
      { status: 500 },
    );
  }
  return NextResponse.json({ playerResponse: outcome.playerResponse });
}
```

- [ ] **Step 2: 从 workspace.ts 删除 writeTurnOutput**

在 `src/lib/workspace.ts` 中，删除 `writeTurnOutput` 函数：

```ts
export async function writeTurnOutput(storyId: string, content: string): Promise<void> {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  await fs.writeFile(path.join(resolveWorkspaceDir(storyId), "turn", "output.md"), content);
}
```

- [ ] **Step 3: 运行全量测试确认通过**

Run:
```bash
pnpm test
```
Expected: 全部 PASS。包括：
- `tests/lib/workspace.test.ts`（无 writeTurnOutput 引用）
- `tests/lib/fake-agent-runner.test.ts`
- `tests/lib/turn-orchestrator.test.ts`
- `tests/api/stories.test.ts`
- `tests/api/story-turn.test.ts`（API 契约不变，自动适配新架构）

- [ ] **Step 4: 验证生产构建**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/app/api/story-turn/route.ts src/lib/workspace.ts
git commit -m "feat(api): wire story-turn to TurnOrchestrator + FakeAgentRunner, remove writeTurnOutput"
```

---

## Task 6: 最终 DoD 验证

**Files:**
- 无文件变更，仅验证

- [ ] **Step 1: 全量测试**

Run:
```bash
pnpm test
```
Expected: 全部测试 PASS（5 个测试文件）：
- `tests/lib/workspace.test.ts`
- `tests/lib/fake-agent-runner.test.ts`
- `tests/lib/turn-orchestrator.test.ts`
- `tests/api/stories.test.ts`
- `tests/api/story-turn.test.ts`

- [ ] **Step 2: 生产构建**

Run:
```bash
pnpm build
```
Expected: 编译成功，无类型错误。

- [ ] **Step 3: 本地运行时冒烟（人工）**

Run:
```bash
pnpm dev
```
打开 `http://localhost:3000`：
- 首页创建故事（标题"酒馆之夜"）→ 跳转故事页
- 故事页输入"推开木门"点发送 → 故事区出现 Fake Agent 输出（含"主角视窗"和"推开木门"）；按钮期间显示"处理中…"并禁用
- 再次输入"观察四周" → 故事区更新为新输出（含"观察四周"）
- 返回首页 → 列表含该故事，点击可再次进入

确认后 `Ctrl+C` 停止 dev server。

---

## 完成定义 (Definition of Done)

Issue 3 完成当且仅当：

1. `pnpm test` 全绿（5 个测试文件）。
2. `pnpm build` 成功，无类型错误。
3. `AgentRunner` 接口定义在 `src/lib/agent-runner.ts`，只含 `runTurn(req): Promise<TurnResult>`，TurnResult 只含 `{ success, error? }`。
4. `FakeAgentRunner` 在 workspaceDir 内直接 fs 写 `turn/output.md`（含主角输入）和 `turn/done.json`（status=success + ISO completedAt），不碰 logs/world/player/actors。
5. `TurnOrchestrator` 编排流程：清理旧 done.json → 写 input.md → 调 runner → 检查 done.json 磁盘状态 → 检查 output.md 非空 → 返回 TurnOutcome。
6. 回合成功条件：done.json 存在且 status=success **且** output.md 存在且内容非空。
7. Runner 抛异常时 Orchestrator 捕获并返回 `{ success: false }`，不传播异常。
8. Runner 不写 done.json 或 output.md 为空时，Orchestrator 返回失败，route 返回受控 500 JSON（`{ error: "回合执行失败，请重试" }`），不崩溃。
9. `story-turn/route.ts` 是薄层：HTTP 解析 + 校验 + 调 orchestrator + 包 NextResponse，不含编排逻辑。
10. Web 返回内容只来自 `turn/output.md`，不读 stdout/logs/world/player/actors。
11. `writeTurnOutput` 已从 workspace.ts 删除，无死代码。
12. `turn/done.json` 不在 `createStory` 骨架中生成。
13. 仓库提交序列清晰：workspace 新增函数 / agent-runner 接口 / fake-agent-runner / turn-orchestrator / route 改造+清理。

## Self-Review 已检查

- **Spec 覆盖**：AgentRunner 接口 ✓（Task2）、FakeAgentRunner ✓（Task3）、TurnOrchestrator 编排 ✓（Task4）、Runner 直接写 workspace ✓（Task3）、Web 只读 output.md ✓（Task4/5）、done.json 成功标记 ✓（Task1/3/4）、每回合冷启动 ✓（FakeAgentRunner 无状态）、受控失败 ✓（Task4/5）、done.json 不在骨架 ✓（Task1 不改 createStory）。
- **未越界**：无 timeout、无 snapshot/rollback、无串行锁、无随机工具、无真实 agent、无故事初始化——均划归后续 issue。
- **占位符扫描**：无 TBD/TODO，每步含完整代码或确切命令。
- **类型/命名一致**：`TurnRequest{storyId,workspaceDir,playerInput}`、`TurnResult{success,error?}`、`TurnOutcome{success,playerResponse,error?}`、`DoneMarker{status,completedAt}`、`AgentRunner.runTurn`、`TurnOrchestrator.executeTurn`、`FakeAgentRunner`、`readTurnDone`、`clearTurnDone`、`resolveWorkspaceDir` 在全部任务中一致。
- **约束 #1 落实**：Orchestrator 检查 done.json + output.md 非空，route 只从 outcome.playerResponse 返回（来自 output.md），有专门的 logs 不泄漏测试（story-turn.test.ts 第 7 个测试）。
- **约束 #2 落实**：Orchestrator catch runner 异常，done 缺失/output 缺失返回受控失败，route 返回 500 JSON 不崩溃。
- **约束 #3 落实**：createStory 不生成 done.json（Task1 不改 createStory），Orchestrator 回合前 clearTurnDone（Task4 Step 3）。
- **API 契约不变**：story-turn.test.ts 无需修改，自动适配新架构。
```
