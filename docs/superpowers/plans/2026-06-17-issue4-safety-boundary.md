# Issue 4 实施计划：安全执行边界（固定输出、串行、快照、失败回滚）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Story Turn 闭环上加串行锁、回合前快照、超时控制、失败整目录回滚，使 agent 半成品状态永远不会污染 Story Workspace。

**Architecture:** TurnOrchestrator 编排扩展——锁（独立模块 `turn-lock.ts`，进程内 `Map<storyId>`）、快照（独立模块 `turn-snapshot.ts`，整目录拷贝到 workspace 外的 `.snapshots/{storyId}/`）、超时（`AbortSignal.timeout` 信号进 `TurnRequest`）、回滚（失败时整目录恢复 + 清空目标）。失败统一走一条路径：先 restore snapshot，再 best-effort 写内部错误日志。

**Tech Stack:** TypeScript, Node.js 22（`AbortSignal.timeout` / `fs.cp` / `fs.rm` 原生支持）, Next.js 15, Vitest 2。

**前置 grill 记录:** `docs/superpowers/grills/2026-06-17-issue4-safety-boundary.md`（含 2026-06-17 review 修正 3 条 + plan 级约束 2 条）。

---

## 关键不变量（每个 Task 都要守住）

1. **锁在 `executeTurn` 入口获取，`try/finally` 释放**。同 storyId 第二次 acquire 抛 `TurnBusyError`。
2. **快照时机**：lock 后第一步 `createSnapshot`，**然后** `clearTurnDone`（clearTurnDone 是本回合第一个 mutation）。快照 = 本回合开始前的完整提交态（含上回合 done.json）。
3. **失败路径顺序**：`restoreSnapshot` → `appendTurnError`（best-effort）。日志在 `workspace/logs/` 下，必须在整目录恢复之后写，否则被覆盖丢失。
4. **回滚 = 整目录恢复**：先 `fs.rm` 清空目标 workspace，再从 snapshot 拷回。`fs.cp` 默认不删多余文件，不清空会有残留。
5. **snapshot 生命周期**：成功回合结束后删除本次 snapshot；失败 restore 完成后也删除。删除失败只记内部日志，不影响用户响应。CONTEXT.md「存活期不超过一次回合」成立。
6. **AgentRunner contract**：runner **必须**响应 `TurnRequest.signal`；abort 后停止并 reject/返回失败。真实 CLI Runner（Issue 6）须把 signal 传到子进程层。**不接受 Promise.race-only 超时**——那样超时后幽灵写入会破坏回滚原子性。
7. **用户可见响应**：成功 `{ playerResponse }` 200；失败 `{ error: "回合执行失败，请重试", retryInput }` 500；并发 `{ error: "故事正在执行，请稍候" }` 409（无 retryInput，用户输入还在前端输入框）。内部 error 分类只进 `logs/turn-errors.log`。

---

## 文件结构

```
src/lib/
├── turn-lock.ts          # 新：进程内并发锁。per-storyId 互斥，acquire/release，重复 acquire 抛 TurnBusyError
├── turn-snapshot.ts      # 新：整目录快照/恢复/删除。路径 {WORKSPACE_ROOT}/.snapshots/{storyId}/，纯 fs API
├── turn-error-log.ts     # 新：appendTurnError，写 workspace/logs/turn-errors.log（JSONL），best-effort
├── workspace.ts          # 改：新增 resolveSnapshotsRoot()，复用 isValidStoryId 过滤 .snapshots（零改动 listStories）
├── agent-runner.ts       # 改：TurnRequest 新增 signal: AbortSignal；JSDoc 强化 contract（必须响应 signal）
├── fake-agent-runner.ts  # 改：runTurn 入口 signal.throwIfAborted()（honors contract，Fake Agent 瞬时不触发）
└── turn-orchestrator.ts  # 改：编排 lock + snapshot + timeout + rollback；try/finally 释放锁；失败路径统一
src/app/api/story-turn/route.ts  # 改：TurnBusyError → 409；失败 → 500 带 retryInput
src/app/stories/[storyId]/page.tsx  # 改：失败响应回填 retryInput 到输入框
tests/lib/
├── turn-lock.test.ts            # 新
├── turn-snapshot.test.ts        # 新
├── turn-error-log.test.ts       # 新
├── turn-orchestrator.test.ts    # 改：现有 runner runTurn 调用补 signal；新增 rollback/lock/timeout 测试
├── fake-agent-runner.test.ts    # 改：runTurn 调用补 signal
└── workspace.test.ts            # 改：新增 resolveSnapshotsRoot 测试
tests/api/story-turn.test.ts     # 改：新增 409 并发测试、500 retryInput 测试
```

**职责边界**：

| 模块 | 职责 | 文件访问 |
|------|------|---------|
| `turn-lock.ts` | 进程内 per-storyId 互斥 | 纯内存 |
| `turn-snapshot.ts` | 整目录快照/恢复/删除，snapshot 在 workspace 外 | 直接 fs（`.snapshots/` 不属 workspace.ts 管辖） |
| `turn-error-log.ts` | 追加写 workspace/logs/turn-errors.log | 通过 workspace.ts 解析路径 + 直接 fs 追加 |
| `workspace.ts` | Web 侧 workspace 唯一入口 + snapshots 根路径解析 | 自身函数 |
| `AgentRunner` | 在 workspaceDir 内写 output.md + done.json；honor signal | 直接 fs |
| `TurnOrchestrator` | 编排锁/snapshot/超时/回滚；try/finally 释放锁 | 通过各模块 |
| `story-turn/route.ts` | HTTP 解析 + 区分 409/500 + NextResponse | 不访问文件 |

---

## Task 1: 进程内串行锁 `turn-lock.ts`

**Files:**
- Create: `src/lib/turn-lock.ts`
- Test: `tests/lib/turn-lock.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/lib/turn-lock.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { TurnLock, TurnBusyError } from "@/lib/turn-lock";

describe("TurnLock", () => {
  let lock: TurnLock;
  beforeEach(() => {
    lock = new TurnLock();
  });

  it("first acquire succeeds and returns a release function", () => {
    const release = lock.acquire("story-1");
    expect(typeof release).toBe("function");
  });

  it("second acquire for same storyId throws TurnBusyError", () => {
    lock.acquire("story-1");
    expect(() => lock.acquire("story-1")).toThrow(TurnBusyError);
  });

  it("different storyId can be acquired independently", () => {
    lock.acquire("story-1");
    expect(() => lock.acquire("story-2")).not.toThrow();
  });

  it("release allows re-acquire for same storyId", () => {
    const release = lock.acquire("story-1");
    release();
    expect(() => lock.acquire("story-1")).not.toThrow();
  });

  it("release is idempotent (calling twice does not throw)", () => {
    const release = lock.acquire("story-1");
    release();
    expect(() => release()).not.toThrow();
  });

  it("TurnBusyError carries the storyId", () => {
    lock.acquire("story-1");
    try {
      lock.acquire("story-1");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TurnBusyError);
      expect((e as TurnBusyError).storyId).toBe("story-1");
    }
  });

  it("isReleased reports state correctly", () => {
    expect(lock.isReleased("story-1")).toBe(true);
    lock.acquire("story-1");
    expect(lock.isReleased("story-1")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/lib/turn-lock.test.ts`
Expected: FAIL —— `turn-lock.ts` 不存在，import 报错。

- [ ] **Step 3: 写最小实现**

`src/lib/turn-lock.ts`:

```typescript
/**
 * 进程内串行锁（Issue 4）。
 * 同一 storyId 同时只能执行一个回合；第二次 acquire 抛 TurnBusyError。
 * 锁只存内存——进程重启自动复位（瞬态，不持久化）。
 * 适用于单 Docker 单 Node 进程的 MVP；多进程场景需外部协调（P2）。
 */

/** 并发拒绝错误。route 层据此返回 409。 */
export class TurnBusyError extends Error {
  constructor(public readonly storyId: string) {
    super(`story ${storyId} is currently running a turn`);
    this.name = "TurnBusyError";
  }
}

export class TurnLock {
  private locked = new Set<string>();

  /**
   * 获取 storyId 的锁。若已被占用，抛 TurnBusyError。
   * 返回 release 函数（幂等，可多次调用）。
   */
  acquire(storyId: string): () => void {
    if (this.locked.has(storyId)) {
      throw new TurnBusyError(storyId);
    }
    this.locked.add(storyId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked.delete(storyId);
    };
  }

  /** 查询 storyId 是否未被锁定（true = 可获取）。 */
  isReleased(storyId: string): boolean {
    return !this.locked.has(storyId);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/lib/turn-lock.test.ts`
Expected: PASS（8 个测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/turn-lock.ts tests/lib/turn-lock.test.ts
git commit -m "feat(orchestrator): add in-process TurnLock with TurnBusyError"
```

---

## Task 2: workspace.ts 新增 snapshots 根路径解析

**Files:**
- Modify: `src/lib/workspace.ts`（在 `resolveWorkspaceDir` 之后新增 `resolveSnapshotsRoot`）
- Test: `tests/lib/workspace.test.ts`（新增一个 describe 块）

- [ ] **Step 1: 写失败测试**

在 `tests/lib/workspace.test.ts` 末尾追加（`resolveWorkspaceDir` 的 describe 块之后）：

```typescript
import {
  // ... 现有 imports ...
  resolveSnapshotsRoot,
} from "@/lib/workspace";

describe("resolveSnapshotsRoot", () => {
  it("resolves to .snapshots under WORKSPACE_ROOT", () => {
    expect(resolveSnapshotsRoot()).toBe(path.resolve(root, ".snapshots"));
  });
});
```

（把 `resolveSnapshotsRoot` 加进文件顶部的 import 列表。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/lib/workspace.test.ts`
Expected: FAIL —— `resolveSnapshotsRoot` 未导出。

- [ ] **Step 3: 写最小实现**

在 `src/lib/workspace.ts` 的 `resolveWorkspaceDir` 函数之后新增：

```typescript
/**
 * snapshots 根目录（Issue 4）。
 * 快照存放在 Story Workspace 之外：{WORKSPACE_ROOT}/.snapshots/{storyId}/。
 * 不是 Story Workspace 的一部分——见 CONTEXT.md「Turn Snapshot」。
 * listStories 已用 isValidStoryId 过滤，.snapshots 非 UUID，自动被忽略，零改动。
 */
export function resolveSnapshotsRoot(): string {
  return path.resolve(resolveWorkspaceRoot(), ".snapshots");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/lib/workspace.test.ts`
Expected: PASS（现有测试 + 新增 resolveSnapshotsRoot 测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/workspace.ts tests/lib/workspace.test.ts
git commit -m "feat(workspace): expose resolveSnapshotsRoot for Issue 4 snapshots"
```

---

## Task 3: 整目录快照/恢复/删除 `turn-snapshot.ts`

**Files:**
- Create: `src/lib/turn-snapshot.ts`
- Test: `tests/lib/turn-snapshot.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/lib/turn-snapshot.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createStory,
  resolveWorkspaceDir,
  resolveSnapshotsRoot,
} from "@/lib/workspace";
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
} from "@/lib/turn-snapshot";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("turn-snapshot", () => {
  it("createSnapshot copies entire workspace to .snapshots/{storyId}", async () => {
    const meta = await createStory({ title: "快照创建测试" });
    // 改一个文件，确认快照能抓到当前内容
    await fs.writeFile(
      path.join(resolveWorkspaceDir(meta.storyId), "world.md"),
      "改过的世界",
    );
    await createSnapshot(meta.storyId);
    const snapDir = path.join(resolveSnapshotsRoot(), meta.storyId);
    const world = await fs.readFile(path.join(snapDir, "world.md"), "utf8");
    expect(world).toBe("改过的世界");
    // story.md 也在（整目录）
    await expect(fs.access(path.join(snapDir, "story.md"))).resolves.toBeUndefined();
  });

  it("createSnapshot captures current done.json (snapshot before mutation)", async () => {
    const meta = await createStory();
    // 模拟"上一回合结束时"存在 done.json
    await fs.writeFile(
      path.join(resolveWorkspaceDir(meta.storyId), "turn", "done.json"),
      JSON.stringify({ status: "success", completedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await createSnapshot(meta.storyId);
    const snapDone = await fs.readFile(
      path.join(resolveSnapshotsRoot(), meta.storyId, "turn", "done.json"),
      "utf8",
    );
    expect(snapDone).toContain("2026-01-01");
  });

  it("restoreSnapshot restores entire workspace, removing files added after snapshot", async () => {
    const meta = await createStory();
    await createSnapshot(meta.storyId);
    const wsDir = resolveWorkspaceDir(meta.storyId);
    // 模拟 runner 写了半成品：加新文件 + 改现有文件
    await fs.writeFile(path.join(wsDir, "actors", "new-npc.md"), "半成品 NPC");
    await fs.writeFile(path.join(wsDir, "turn", "output.md"), "半成品输出");
    // 确认新文件存在
    await expect(fs.access(path.join(wsDir, "actors", "new-npc.md"))).resolves.toBeUndefined();

    await restoreSnapshot(meta.storyId);

    // 关键：runner 新增的文件必须被清除（fs.cp 默认不删，需先 rm）
    await expect(fs.access(path.join(wsDir, "actors", "new-npc.md"))).rejects.toThrow();
    // output.md 回到快照态（占位符）
    const output = await fs.readFile(path.join(wsDir, "turn", "output.md"), "utf8");
    expect(output).not.toBe("半成品输出");
  });

  it("restoreSnapshot restores done.json captured at snapshot time", async () => {
    const meta = await createStory();
    await fs.writeFile(
      path.join(resolveWorkspaceDir(meta.storyId), "turn", "done.json"),
      JSON.stringify({ status: "success", completedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await createSnapshot(meta.storyId);
    // 模拟 runner 失败：done.json 被改成坏值或删除
    await fs.writeFile(
      path.join(resolveWorkspaceDir(meta.storyId), "turn", "done.json"),
      "corrupt",
    );
    await restoreSnapshot(meta.storyId);
    const done = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "turn", "done.json"),
      "utf8",
    );
    expect(done).toContain("2026-01-01");
  });

  it("deleteSnapshot removes the snapshot directory", async () => {
    const meta = await createStory();
    await createSnapshot(meta.storyId);
    const snapDir = path.join(resolveSnapshotsRoot(), meta.storyId);
    await expect(fs.access(snapDir)).resolves.toBeUndefined();
    await deleteSnapshot(meta.storyId);
    await expect(fs.access(snapDir)).rejects.toThrow();
  });

  it("deleteSnapshot is no-op when snapshot does not exist", async () => {
    const meta = await createStory();
    await expect(deleteSnapshot(meta.storyId)).resolves.toBeUndefined();
  });

  it("restoreSnapshot throws if snapshot does not exist (programmer error)", async () => {
    const meta = await createStory();
    await expect(restoreSnapshot(meta.storyId)).rejects.toThrow();
  });

  it("snapshot does NOT live inside the workspace directory", async () => {
    const meta = await createStory();
    await createSnapshot(meta.storyId);
    const wsDir = resolveWorkspaceDir(meta.storyId);
    // .snapshots 必须在 workspace 外
    const snapInsideWorkspace = path.join(wsDir, ".snapshot");
    await expect(fs.access(snapInsideWorkspace)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/lib/turn-snapshot.test.ts`
Expected: FAIL —— `turn-snapshot.ts` 不存在。

- [ ] **Step 3: 写最小实现**

`src/lib/turn-snapshot.ts`:

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidStoryId, resolveWorkspaceDir, resolveSnapshotsRoot } from "./workspace";

/**
 * 整目录回合快照（Issue 4）。
 * 快照存放在 Story Workspace 之外（{WORKSPACE_ROOT}/.snapshots/{storyId}/）。
 * 不是故事状态——见 CONTEXT.md「Turn Snapshot」。存活期不超过一次回合。
 */

function resolveSnapshotDir(storyId: string): string {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  return path.resolve(resolveSnapshotsRoot(), storyId);
}

/**
 * 创建整目录快照（覆盖上一份）。
 * 在 lock 之后、clearTurnDone 之前调用——捕获"本回合开始前的完整提交态"。
 */
export async function createSnapshot(storyId: string): Promise<void> {
  const src = resolveWorkspaceDir(storyId);
  const dest = resolveSnapshotDir(storyId);
  // 清掉旧快照再拷，确保 dest 是 src 的精确镜像
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(resolveSnapshotsRoot(), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
}

/**
 * 从快照整目录恢复 workspace。
 * 先清空目标 workspace（rm -rf），再从快照拷回。
 * fs.cp 默认不删目标多余文件，不清空会导致 runner 新增的文件残留——回滚不干净。
 */
export async function restoreSnapshot(storyId: string): Promise<void> {
  const snap = resolveSnapshotDir(storyId);
  const ws = resolveWorkspaceDir(storyId);
  // 快照必须存在，否则是编排逻辑错误
  await fs.access(snap);
  await fs.rm(ws, { recursive: true, force: true });
  await fs.cp(snap, ws, { recursive: true });
}

/**
 * 删除本次快照。成功回合结束 / 失败 restore 完成后调用。
 * best-effort：删除失败不抛（调用方记内部日志即可，不影响用户响应）。
 */
export async function deleteSnapshot(storyId: string): Promise<void> {
  await fs.rm(resolveSnapshotDir(storyId), { recursive: true, force: true });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/lib/turn-snapshot.test.ts`
Expected: PASS（8 个测试全绿）。特别确认 "restoring removes files added after snapshot" 通过——这是回滚原子性的核心保证。

- [ ] **Step 5: 提交**

```bash
git add src/lib/turn-snapshot.ts tests/lib/turn-snapshot.test.ts
git commit -m "feat(orchestrator): add whole-directory turn snapshot/restore/delete"
```

---

## Task 4: 内部错误日志 `turn-error-log.ts`

**Files:**
- Create: `src/lib/turn-error-log.ts`
- Test: `tests/lib/turn-error-log.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/lib/turn-error-log.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { appendTurnError } from "@/lib/turn-error-log";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("appendTurnError", () => {
  it("writes a JSONL line to logs/turn-errors.log", async () => {
    const meta = await createStory();
    await appendTurnError(meta.storyId, { reason: "runner crashed", input: "推开木门" });
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.reason).toBe("runner crashed");
    expect(entry.storyId).toBe(meta.storyId);
    expect(entry.input).toBe("推开木门");
    expect(() => new Date(entry.at).toISOString()).not.toThrow();
  });

  it("appends multiple errors as separate JSONL lines", async () => {
    const meta = await createStory();
    await appendTurnError(meta.storyId, { reason: "first" });
    await appendTurnError(meta.storyId, { reason: "second" });
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).reason).toBe("first");
    expect(JSON.parse(lines[1]).reason).toBe("second");
  });

  it("input field is optional", async () => {
    const meta = await createStory();
    await appendTurnError(meta.storyId, { reason: "no input ctx" });
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    const entry = JSON.parse(raw.trim());
    expect(entry.reason).toBe("no input ctx");
    expect(entry.input).toBeUndefined();
  });

  it("does not throw on append failure (best-effort) — e.g. invalid storyId", async () => {
    // invalid storyId → 路径解析会抛，但 appendTurnError 应吞掉（best-effort）
    await expect(
      appendTurnError("not-a-uuid", { reason: "x" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/lib/turn-error-log.test.ts`
Expected: FAIL —— `turn-error-log.ts` 不存在。

- [ ] **Step 3: 写最小实现**

`src/lib/turn-error-log.ts`:

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidStoryId, resolveWorkspaceDir } from "./workspace";

/**
 * 失败回合的内部错误日志（Issue 4，US 42）。
 * 写入 workspace/logs/turn-errors.log（JSONL，追加）。
 * 与 turn/output.md（主角可见）严格分离。
 *
 * **best-effort**：日志写入失败不应覆盖原始失败，也不应阻止向用户返回失败响应。
 * 因此本函数吞掉所有异常——调用方只管调，不处理返回。
 *
 * **必须在 restoreSnapshot 之后调用**：本日志位于 workspace/logs/ 下，
 * 属于整目录快照/恢复范围，先写日志再 restore 会被覆盖丢失。
 */
export async function appendTurnError(
  storyId: string,
  entry: { reason: string; input?: string },
): Promise<void> {
  try {
    if (!isValidStoryId(storyId)) return;
    const logPath = path.join(resolveWorkspaceDir(storyId), "logs", "turn-errors.log");
    const line = JSON.stringify({
      at: new Date().toISOString(),
      storyId,
      reason: entry.reason,
      ...(entry.input !== undefined ? { input: entry.input } : {}),
    });
    await fs.appendFile(logPath, line + "\n");
  } catch {
    // best-effort：吞掉，不覆盖原始失败
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/lib/turn-error-log.test.ts`
Expected: PASS（4 个测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/turn-error-log.ts tests/lib/turn-error-log.test.ts
git commit -m "feat(orchestrator): add best-effort appendTurnError to logs/turn-errors.log"
```

---

## Task 5: AgentRunner contract 强化——signal 进 TurnRequest

**Files:**
- Modify: `src/lib/agent-runner.ts`
- Modify: `src/lib/fake-agent-runner.ts`（honors signal）
- Modify: `tests/lib/fake-agent-runner.test.ts`（现有 runTurn 调用补 signal）

- [ ] **Step 1: 修改类型定义**

把 `src/lib/agent-runner.ts` 的 `TurnRequest` 改为：

```typescript
/** 传给 AgentRunner 的回合请求 */
export interface TurnRequest {
  /** 故事 ID（UUID v4） */
  storyId: string;
  /** workspace 绝对路径，runner 在此目录内读写 */
  workspaceDir: string;
  /** 主角本回合输入（与 turn/input.md 内容一致，便利字段） */
  playerInput: string;
  /**
   * 回合超时信号（Issue 4）。
   * 由 Orchestrator 用 AbortSignal.timeout(ms) 创建。
   *
   * **Contract（强制）**：runner 必须响应此 signal：
   * - runTurn 入口应尽早 signal.throwIfAborted()。
   * 长耗时操作（子进程、网络）必须把 signal 传到底层（child_process.exec / fetch）。
   * abort 后 runner 必须停止执行并 reject 或返回 { success: false }。
   * 真实 CLI Runner（Issue 6）必须把 signal 传到子进程层，避免 timeout 后幽灵写入。
   * **不接受 Promise.race-only 超时**——那样超时后 runner 仍在后台写文件，破坏回滚原子性。
   */
  signal: AbortSignal;
}
```

`TurnResult` 和 `AgentRunner` 接口不变。

- [ ] **Step 2: FakeAgentRunner honors signal**

把 `src/lib/fake-agent-runner.ts` 的 `runTurn` 开头加 abort 检查：

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "./agent-runner";

/**
 * Fake Agent Runner — Issue 3 验证用实现。
 * 不接入真实大模型，读取 playerInput 后生成固定格式输出。
 * 只写 turn/output.md 和 turn/done.json，不碰其他 workspace 文件。
 * 是临时验证组件，非永久产品运行时。
 *
 * Issue 4：honors TurnRequest.signal（入口 throwIfAborted）。
 * Fake Agent 瞬时完成，正常路径永不触发 abort；但 contract 要求响应 signal，
 * 不响应会退化为 Promise.race-only 的幽灵写入风险。
 */
export class FakeAgentRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    // honor contract：入口检查 abort（Fake Agent 瞬时，此处正常不触发）
    req.signal.throwIfAborted();

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

    // 写文件前再查一次 abort（演示 contract；真实 runner 在子进程层响应）
    req.signal.throwIfAborted();

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

- [ ] **Step 3: 修现有 fake-agent-runner 测试（补 signal）**

把 `tests/lib/fake-agent-runner.test.ts` 里三处 `runTurn({...})` 调用补 `signal` 字段。每处把：

```typescript
await runner.runTurn({
  storyId: meta.storyId,
  workspaceDir: resolveWorkspaceDir(meta.storyId),
  playerInput: "...",
});
```

改为：

```typescript
await runner.runTurn({
  storyId: meta.storyId,
  workspaceDir: resolveWorkspaceDir(meta.storyId),
  playerInput: "...",
  signal: AbortSignal.timeout(5000),
});
```

（三处都改，保持各自原本的 playerInput 值：`"推开木门"` / `"观察四周"` / `"试探"` / `"不动"`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/lib/fake-agent-runner.test.ts`
Expected: PASS（4 个现有测试全绿——signal 补上后接口匹配，Fake Agent 正常路径不触发 abort）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent-runner.ts src/lib/fake-agent-runner.ts tests/lib/fake-agent-runner.test.ts
git commit -m "feat(adapter): add AbortSignal to TurnRequest, fake runner honors it"
```

---

## Task 6: TurnOrchestrator 编排扩展——锁 + 快照 + 超时 + 回滚

**Files:**
- Modify: `src/lib/turn-orchestrator.ts`
- Modify: `tests/lib/turn-orchestrator.test.ts`

这是 Issue 4 的核心 Task。现有 orchestrator 测试里的 runner runTurn 调用都**不经过 orchestrator**（直接 `new FakeAgentRunner()` 传进 orchestrator），所以 orchestrator 测试**不需要**给 runner runTurn 补 signal——orchestrator 内部会构造 req 含 signal。但 orchestrator 测试里的自定义 runner（CrashingRunner/NoopRunner/EmptyOutputRunner）实现 `AgentRunner` 接口，接口签名没变（还是 `runTurn(req)`），只是 req 多了 signal 字段，TS 不报错（runner 不读 req 也行）。

- [ ] **Step 1: 重写 orchestrator 实现**

完全替换 `src/lib/turn-orchestrator.ts`：

```typescript
import type { AgentRunner, TurnResult } from "./agent-runner";
import {
  clearTurnDone,
  readTurnDone,
  readTurnOutput,
  resolveWorkspaceDir,
  writeTurnInput,
} from "./workspace";
import { TurnLock, TurnBusyError } from "./turn-lock";
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
} from "./turn-snapshot";
import { appendTurnError } from "./turn-error-log";

/** 默认回合超时 60s（Issue 4）。可经 TURN_TIMEOUT_MS 覆盖。 */
function resolveTurnTimeoutMs(): number {
  const raw = process.env.TURN_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
}

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
 * 回合生命周期编排器（Issue 4 扩展）。
 * 编排：锁 → 快照 → clear done → 写 input → 超时信号 → runner → 磁盘权威检查 → 读 output。
 * 失败路径统一：restore snapshot → best-effort 写错误日志 → 删除快照。
 * 成功路径：删除快照。
 * 锁用 try/finally 保证释放。
 * 持有 AgentRunner 实例 + TurnLock 实例，对回合内的所有失败负责。
 * 不直接 fs，通过各模块读写。
 */
export class TurnOrchestrator {
  private readonly lock = new TurnLock();

  constructor(private runner: AgentRunner) {}

  async executeTurn(storyId: string, playerInput: string): Promise<TurnOutcome> {
    // 1. 获取串行锁。失败抛 TurnBusyError（route 转 409）。
    //    注意：锁在 snapshot 之前——并发拒绝不应留下半成品快照。
    const release = this.lock.acquire(storyId);
    try {
      return await this.runWithSnapshot(storyId, playerInput);
    } finally {
      release();
    }
  }

  private async runWithSnapshot(
    storyId: string,
    playerInput: string,
  ): Promise<TurnOutcome> {
    // 2. 快照（lock 后第一步）——捕获"本回合开始前的完整提交态"（含上回合 done.json）。
    await createSnapshot(storyId);

    // 3. clearTurnDone 是本回合第一个 mutation，必须在 snapshot 之后。
    await clearTurnDone(storyId);

    // 4. 写入本次主角输入
    await writeTurnInput(storyId, playerInput);

    // 5. 构造回合请求（含超时信号）
    const workspaceDir = resolveWorkspaceDir(storyId);
    const signal = AbortSignal.timeout(resolveTurnTimeoutMs());
    const req = { storyId, workspaceDir, playerInput, signal };

    // 6. 调用 runner（捕获异常，统一转失败）
    let result: TurnResult;
    try {
      result = await this.runner.runTurn(req);
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : "runner crashed";
      return await this.failTurn(storyId, reason, playerInput);
    }

    // 7. 磁盘权威检查：done.json 必须存在且 status=success
    const done = await readTurnDone(storyId);
    if (!done || done.status !== "success") {
      return await this.failTurn(
        storyId,
        result.error ?? "done marker missing",
        playerInput,
      );
    }

    // 8. output.md 必须存在且非空
    const playerResponse = await readTurnOutput(storyId);
    if (!playerResponse || playerResponse.trim() === "") {
      return await this.failTurn(storyId, "output missing or empty", playerInput);
    }

    // 9. 成功：删除本次快照，返回从文件读取的主角可见输出
    await deleteSnapshot(storyId);
    return { success: true, playerResponse };
  }

  /**
   * 统一失败路径（Issue 4）。
   * 顺序：restore snapshot → best-effort 写错误日志 → 删除快照。
   * 日志在 workspace/logs/ 下，必须在整目录恢复之后写，否则被覆盖丢失。
   */
  private async failTurn(
    storyId: string,
    reason: string,
    playerInput: string,
  ): Promise<TurnOutcome> {
    try {
      await restoreSnapshot(storyId);
      // restore 成功后再写日志（best-effort）
      await appendTurnError(storyId, { reason, input: playerInput });
      // 删除本次快照
      await deleteSnapshot(storyId);
    } catch {
      // restore/delete 失败不应阻塞向用户返回失败响应；appendTurnError 自身已 best-effort
    }
    return { success: false, playerResponse: null, error: reason };
  }
}

export { TurnBusyError };
```

- [ ] **Step 2: 修现有 orchestrator 测试中"clears old done.json"用例**

现有用例 `"clears old done.json before calling runner"` 用 NoopRunner，断言 `done.json` 被清理。**Issue 4 改变了语义**：clearTurnDone 现在在 snapshot 之后，且回滚会恢复 done.json。NoopRunner 不写 done → 触发 failTurn → restoreSnapshot 把 done.json 恢复成测试手动写的那个。

把这个测试用例（`tests/lib/turn-orchestrator.test.ts` 里的 `"clears old done.json before calling runner"`）替换为验证 Issue 4 的新语义：

```typescript
it("failed turn restores workspace to pre-turn state (Issue 4 rollback)", async () => {
  const meta = await createStory();
  const wsDir = path.join(root, meta.storyId);
  // 手动写入上一回合的 done.json（快照应捕获它）
  const donePath = path.join(wsDir, "turn", "done.json");
  const prevDone = JSON.stringify({
    status: "success",
    completedAt: "2000-01-01T00:00:00.000Z",
  });
  await fs.writeFile(donePath, prevDone);
  // 模拟 runner 写半成品 + 失败（不写有效 done.json）
  await fs.writeFile(path.join(wsDir, "actors", "half-baked-npc.md"), "半成品");
  // 用 NoopRunner（不写 done.json）→ 触发失败 → 回滚
  const orchestrator = new TurnOrchestrator(new NoopRunner());
  const outcome = await orchestrator.executeTurn(meta.storyId, "测试");
  expect(outcome.success).toBe(false);
  // 关键：回滚后 done.json 恢复为快照态（上回合的成功标记），不是被清理
  const restoredDone = await fs.readFile(donePath, "utf8");
  expect(restoredDone).toBe(prevDone);
  // runner 新增的半成品文件被清除
  await expect(fs.access(path.join(wsDir, "actors", "half-baked-npc.md"))).rejects.toThrow();
});
```

注意：**保留**其他现有 orchestrator 测试（success / crash / missing done / empty output / writes input）。它们的 runner 通过 orchestrator 调用，orchestrator 内部构造含 signal 的 req，自定义 runner 不读 req 也能编译通过。

- [ ] **Step 3: 新增 timeout 测试**

在 `tests/lib/turn-orchestrator.test.ts` 顶部加测试 runner 定义（与现有 CrashingRunner 等并列）：

```typescript
/** 超时模拟 runner：永不返回，直到 signal abort。 */
class HangingRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    // honor contract：监听 signal，abort 后 reject
    return await new Promise<TurnResult>((_, reject) => {
      req.signal.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
  }
}
```

（注意：这里 reject 的是普通 Error，不是 DOMException AbortError——orchestrator 用 `err.name === "AbortError"` 判断。为了让 orchestrator 把它归类为 "timeout"，改成 reject 一个 name 为 AbortError 的错误：）

```typescript
class HangingRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    return await new Promise<TurnResult>((_, reject) => {
      req.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }
}
```

新增测试用例：

```typescript
it("timeout: hanging runner is aborted, turn fails with timeout reason", async () => {
  const meta = await createStory();
  // 用极短超时，避免测试等待 60s
  const prev = process.env.TURN_TIMEOUT_MS;
  process.env.TURN_TIMEOUT_MS = "50";
  try {
    const orchestrator = new TurnOrchestrator(new HangingRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "等待");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("timeout");
  } finally {
    if (prev === undefined) delete process.env.TURN_TIMEOUT_MS;
    else process.env.TURN_TIMEOUT_MS = prev;
  }
});
```

- [ ] **Step 4: 新增 rollback 保持 workspace 干净的测试**

```typescript
it("rollback removes files the runner wrote before failing", async () => {
  const meta = await createStory();
  const wsDir = path.join(root, meta.storyId);
  const worldBefore = await fs.readFile(path.join(wsDir, "world.md"), "utf8");

  // runner 写了半成品 world.md + 新文件，但不写 done.json → 失败
  class HalfBakedRunner implements AgentRunner {
    async runTurn(req: TurnRequest): Promise<TurnResult> {
      const dir = req.workspaceDir;
      await fs.writeFile(path.join(dir, "world.md"), "被污染的世界");
      await fs.writeFile(path.join(dir, "actors", "ghost.md"), "幽灵 NPC");
      // 故意不写 done.json → 触发失败
      return { success: false, error: "half-baked" };
    }
  }
  const orchestrator = new TurnOrchestrator(new HalfBakedRunner());
  const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
  expect(outcome.success).toBe(false);

  // 回滚后 world.md 回到快照态
  const worldAfter = await fs.readFile(path.join(wsDir, "world.md"), "utf8");
  expect(worldAfter).toBe(worldBefore);
  // 幽灵文件被清除
  await expect(fs.access(path.join(wsDir, "actors", "ghost.md"))).rejects.toThrow();
});
```

- [ ] **Step 5: 新增 锁拒绝第二个并发回合 测试**

```typescript
it("second concurrent turn for same storyId throws TurnBusyError", async () => {
  const meta = await createStory();
  const orchestrator = new TurnOrchestrator(new HangingRunner());
  // 用短超时
  const prev = process.env.TURN_TIMEOUT_MS;
  process.env.TURN_TIMEOUT_MS = "2000";
  try {
    // 第一个回合挂起（HangingRunner 不返回），但不 await
    const p1 = orchestrator.executeTurn(meta.storyId, "第一回合");
    // 让事件循环推进，让 p1 真正拿到锁
    await new Promise((r) => setTimeout(r, 10));
    // 第二个回合应被锁拒绝
    await expect(orchestrator.executeTurn(meta.storyId, "并发")).rejects.toThrow(
      TurnBusyError,
    );
    // 等第一个回合超时结束（释放锁）
    process.env.TURN_TIMEOUT_MS = "50";
    // 重置超时已晚——p1 用的是创建时的 2000ms。这里只需等它 reject 即可
    await expect(p1).rejects.toThrow();
  } finally {
    if (prev === undefined) delete process.env.TURN_TIMEOUT_MS;
    else process.env.TURN_TIMEOUT_MS = prev;
  }
});
```

注意：`TurnBusyError` 要从 orchestrator 导入。在测试文件顶部 import 加 `TurnBusyError`：

```typescript
import { TurnOrchestrator, TurnBusyError } from "@/lib/turn-orchestrator";
```

- [ ] **Step 6: 新增 成功回合删除快照 测试**

```typescript
it("successful turn deletes its snapshot", async () => {
  const meta = await createStory();
  const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
  await orchestrator.executeTurn(meta.storyId, "成功");
  // 快照目录应不存在（成功后删除）
  const { resolveSnapshotsRoot } = await import("@/lib/workspace");
  const snapDir = path.join(resolveSnapshotsRoot(), meta.storyId);
  await expect(fs.access(snapDir)).rejects.toThrow();
});
```

- [ ] **Step 7: 运行所有 orchestrator 测试确认通过**

Run: `pnpm vitest run tests/lib/turn-orchestrator.test.ts`
Expected: PASS（所有现有 + 新增测试全绿）。如果 timeout 测试不稳定（50ms 偶尔不够），调到 200ms。

- [ ] **Step 8: 提交**

```bash
git add src/lib/turn-orchestrator.ts tests/lib/turn-orchestrator.test.ts
git commit -m "feat(orchestrator): add lock, snapshot, timeout, rollback to executeTurn"
```

---

## Task 7: API route 区分 409 并发 / 500 失败 + retryInput

**Files:**
- Modify: `src/app/api/story-turn/route.ts`
- Modify: `tests/api/story-turn.test.ts`

- [ ] **Step 1: 修改 route 处理 TurnBusyError + retryInput**

完全替换 `src/app/api/story-turn/route.ts`：

```typescript
import { NextResponse } from "next/server";
import { isValidStoryId, workspaceExists } from "@/lib/workspace";
import { TurnOrchestrator, TurnBusyError } from "@/lib/turn-orchestrator";
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

  // Issue 4：串行锁拒绝 → 409（无 retryInput，用户输入还在前端输入框）。
  // 回合失败 → 500 + retryInput（回填输入框供重试）。
  // 用户只看固定中文提示，内部 error 分类只进 logs/turn-errors.log（US 42）。
  try {
    const outcome = await orchestrator.executeTurn(storyId, input);
    if (!outcome.success || !outcome.playerResponse) {
      return NextResponse.json(
        { error: "回合执行失败，请重试", retryInput: input },
        { status: 500 },
      );
    }
    return NextResponse.json({ playerResponse: outcome.playerResponse });
  } catch (e) {
    if (e instanceof TurnBusyError) {
      return NextResponse.json(
        { error: "故事正在执行，请稍候" },
        { status: 409 },
      );
    }
    // 非 TurnBusyError 的意外异常：统一走 500 + retryInput
    return NextResponse.json(
      { error: "回合执行失败，请重试", retryInput: input },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: 新增 409 并发测试**

在 `tests/api/story-turn.test.ts` 顶部加 import：

```typescript
import { POST } from "@/app/api/story-turn/route";
import { createStory, readTurnOutput, resolveWorkspaceRoot } from "@/lib/workspace";
```

（已有，保持。再确认 `vitest` 的 `describe/it/expect` 已 import。）

新增测试用例（在现有 describe 块内或新增一个 describe）：

```typescript
describe("POST /api/story-turn (Issue 4: concurrency + retry)", () => {
  it("returns 409 when a turn is already running for the same storyId", async () => {
    const storyId = await freshStory();
    // 触发一个长跑回合（Fake Agent 瞬时，需用慢 runner 注入）。
    // 但 route 内部固定用 FakeAgentRunner——无法从 route 测试注入慢 runner。
    // 改为直接验证 route 对 TurnBusyError 的响应：
    // 这里只测 route 的 catch 分支行为。真正的并发由 orchestrator 测试覆盖。
    // 此测试在 route 层无法稳定构造并发——标记为 orchestrator 测试的责任。
    // route 测试聚焦：失败响应带 retryInput。
    expect(true).toBe(true); // 占位，见下一步替代测试
  });

  it("returns 500 with retryInput when turn fails", async () => {
    const storyId = await freshStory();
    // Fake Agent 总成功，无法从 route 层触发失败。
    // route 层的失败分支由 orchestrator 测试覆盖。
    // 这里验证成功路径仍返回 200（回归保护）。
    const res = await POST(req({ storyId, input: "正常输入" }));
    expect(res.status).toBe(200);
  });
});
```

**重要**：route 测试无法注入慢 runner 或失败 runner（route 内部固定 `new FakeAgentRunner()`，Fake Agent 总成功）。真正的 409/500 分支由 orchestrator 测试覆盖（Task 6 已覆盖）。route 层保留对**成功路径**的回归保护即可。

删除上面的占位测试，只保留回归测试：

```typescript
describe("POST /api/story-turn (Issue 4 regression)", () => {
  it("still returns 200 with playerResponse on success (Fake Agent)", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "Issue 4 回归" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).toContain("Issue 4 回归");
  });
});
```

- [ ] **Step 3: 运行 route 测试确认通过**

Run: `pnpm vitest run tests/api/story-turn.test.ts`
Expected: PASS（现有测试 + 新增回归测试全绿）。

- [ ] **Step 4: 提交**

```bash
git add src/app/api/story-turn/route.ts tests/api/story-turn.test.ts
git commit -m "feat(api): distinguish 409 busy / 500 failed + retryInput in story-turn"
```

---

## Task 8: 前端失败响应回填 retryInput

**Files:**
- Modify: `src/app/stories/[storyId]/page.tsx`

先读现有页面，确认 fetch 与输入框结构。

- [ ] **Step 1: 读现有故事页**

Run: `pnpm exec cat src/app/stories/[storyId]/page.tsx`（或用 Read 工具）

理解现有：输入框 state、submit handler、fetch 调用、错误处理。记录输入框的 state setter 名和 fetch 响应处理逻辑。

- [ ] **Step 2: 修改 fetch 错误处理，回填 retryInput**

在 submit handler 的 catch / 非 200 分支里，解析响应 JSON，若含 `retryInput` 则回填输入框。具体修改取决于现有代码结构。核心逻辑（以现有结构为基准调整）：

```typescript
// 在非 200 分支
const errorJson = await res.json().catch(() => null);
if (errorJson?.retryInput) {
  setInput(errorJson.retryInput);  // 用现有 setter 名
}
// 显示错误提示（用现有错误显示机制）
setError(errorJson?.error ?? "回合执行失败");
```

409 响应（"故事正在执行"）不带 retryInput，用户输入框里的内容本就还在，只需显示提示，不回填。

- [ ] **Step 3: 手动冒烟（无自动化测试，前端组件）**

Run: `pnpm dev`

浏览器打开 `http://localhost:3000`，创建故事，输入内容，确认成功路径仍工作（回归）。失败路径（Fake Agent 下难触发）逻辑由代码审查保证——Fake Agent 总成功，前端失败分支无法端到端测。记录此限制。

- [ ] **Step 4: 提交**

```bash
git add src/app/stories/[storyId]/page.tsx
git commit -m "feat(ui): refill input from retryInput on turn failure"
```

---

## Task 9: 全量回归 + 收尾

- [ ] **Step 1: 运行全部测试**

Run: `pnpm vitest run`
Expected: 所有测试 PASS。如有失败，定位是 Task 6 orchestrator 重构导致的现有测试不兼容，修测试断言对齐 Issue 4 新语义（参考 Task 6 Step 2 对 "clears old done.json" 用例的处理方式）。

- [ ] **Step 2: TypeScript 类型检查**

Run: `pnpm exec tsc --noEmit`
Expected: 无错误。特别确认 `TurnRequest` 加 signal 后，所有构造 TurnRequest 的地方都补了 signal（orchestrator 内部 + 测试）。

- [ ] **Step 3: 确认 CONTEXT.md 术语完整**

Read `CONTEXT.md`，确认「Turn Snapshot」条目存在且措辞准确（"回合开始前"、"存活期不超过一次回合"、"workspace 外"、"Avoid: 版本历史/备份/checkpoint"）。grill 阶段已写入，此处只核对。

- [ ] **Step 4: 更新 docs/issue.md Issue 4 状态**

在 `docs/issue.md` Issue 4 段落加状态标注（参考 Issue 1-3 的格式）：

```markdown
**Status**: 实现 + 测试完成
- ✅ 代码实现完成（N 个提交对应 plan 的 N 个 Task）
- ✅ 单元测试全绿：turn-lock / turn-snapshot / turn-error-log / orchestrator（含 rollback/timeout/lock）/ route
- ✅ TypeScript 类型检查通过
- ⏭️ 待验证：浏览器人工冒烟（失败回填——Fake Agent 下难触发，由代码审查保证）
- ⏭️ 待验证：Docker 容器内冒烟（与本机无 Docker 同阻塞项，留 Issue 1 验证环境）
```

- [ ] **Step 5: 提交收尾**

```bash
git add docs/issue.md
git commit -m "docs(issue4): mark implementation complete with test status"
```

---

## Self-Review

**Spec coverage**（对照 grill Q1-Q5 + 2 条 plan 约束 + 3 条 review 修正）：

- Q1 串行锁/409/进程内 Map/独立模块 → Task 1 + Task 6（orchestrator 接锁）+ Task 7（route 409）✓
- Q2 整目录快照/workspace 外/createSnapshot 在 clearTurnDone 前 → Task 2（路径）+ Task 3（快照）+ Task 6（编排顺序）✓
- Q3 完整回滚/retryInput/HTTP 500 → Task 3（restore 先清空）+ Task 6（failTurn）+ Task 7（retryInput）+ Task 8（前端回填）✓
- Q4 signal 进 TurnRequest/AbortSignal.timeout/60s/统一回滚/不接受 Promise.race-only → Task 5（contract）+ Task 6（timeout 编排）✓
- Q5a 维持非空校验 → Task 6 Step 1（`playerResponse.trim() === ""` 保留）✓
- Q5b 三态响应 → Task 7 ✓
- Q5c logs/turn-errors.log → Task 4 ✓
- Plan 约束1 snapshot 生命周期（成功/失败都删，删除失败不阻塞）→ Task 3 deleteSnapshot（force:true 不抛）+ Task 6 failTurn try/catch + runWithSnapshot 成功分支 deleteSnapshot ✓
- Plan 约束2 appendTurnError best-effort → Task 4（吞异常）+ Task 6（restore 后调）✓
- Review 修正1 失败路径 restore→log 顺序 → Task 6 failTurn 注释明确 ✓
- Review 修正2 快照时机 lock 后 createSnapshot 再 clearTurnDone → Task 6 runWithSnapshot 注释明确 ✓
- Review 修正3 Runner 必须响应 signal + 不接受 Promise.race-only → Task 5 contract JSDoc + FakeAgentRunner throwIfAborted + HangingRunner 测试 honors signal ✓

**Placeholder scan**: 无 TBD/TODO/"implement later"。Task 8 Step 2 的前端修改承认依赖现有代码结构，给了核心逻辑片段 + "以现有结构为基准调整"——这是因为未读现有 page.tsx，执行时 Step 1 先读再改，逻辑片段足够指导。可接受。

**Type consistency**:
- `TurnLock.acquire(storyId) → () => void`：Task 1 定义，Task 6 用 `const release = this.lock.acquire(storyId)` ✓
- `TurnBusyError`：Task 1 定义带 `storyId`，Task 6 re-export，Task 7 import 自 orchestrator ✓
- `createSnapshot/restoreSnapshot/deleteSnapshot(storyId)`：Task 3 定义，Task 6 全部调用 ✓
- `appendTurnError(storyId, { reason, input? })`：Task 4 定义，Task 6 调用 `appendTurnError(storyId, { reason, input: playerInput })` ✓
- `resolveSnapshotsRoot()`：Task 2 定义，Task 3 用、Task 6 测试用 ✓
- `TurnRequest.signal`：Task 5 加，Task 6 orchestrator 构造 req 含 signal ✓
- `resolveTurnTimeoutMs`：Task 6 私有函数，读 `TURN_TIMEOUT_MS`，默认 60000 ✓

**已知 trade-off / 执行注意**（plan 作者与执行者必读）：
1. **AbortSignal.timeout(50) 测试稳定性**：Task 6 timeout 测试用 50ms，偶发慢机可能 flaky。调到 200ms 更稳，代价是测试慢 150ms。
2. **route 层无法测 409/500**：route 内部固定 FakeAgentRunner，Fake Agent 总成功。409/500 分支由 orchestrator 测试覆盖。route 测试只保成功回归。
3. **前端失败分支无法端到端测**：同上，Fake Agent 总成功。Task 8 手动冒烟只能测成功回归，失败回填由代码审查保证。
4. **整目录拷贝性能**：MVP 小场景 workspace 小，毫秒级。真实 agent（Issue 6）写大量文件后每回合拷贝成本上升——Issue 4 接受（优化是 P1）。
5. **锁的单进程假设**：当前单 Docker 单 Node 进程安全。多进程（P2）失效，需外部协调。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-17-issue4-safety-boundary.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 Task 派 fresh subagent，Task 间两阶段审查，快速迭代。
2. **Inline Execution** — 当前会话内批量执行，checkpoint 审查。

Which approach?
