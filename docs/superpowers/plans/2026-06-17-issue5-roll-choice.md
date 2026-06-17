# Issue 5 Implementation Plan: Tool-Based Roll Choice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Random Tool seam (`rollChoice`) that selects weighted outcomes, appends internal random logs, and proves a story turn can bind player-visible output to the selected result.

**Architecture:** Implement `rollChoice` as a focused TypeScript domain module in `src/lib/random-tool.ts`; it receives `storyId`, `workspaceDir`, `rollId`, `candidates`, and optional `rng`, then writes `logs/random-rolls.jsonl` using the provided `workspaceDir`. Keep default `FakeAgentRunner` unchanged; use test-only integration runners to prove the seam through `TurnOrchestrator`. Do not add a public `/api/random` endpoint or a CLI wrapper in Issue 5.

**Tech Stack:** TypeScript, Node.js 22 (`crypto`, `fs/promises`), Next.js 15 route tests, Vitest 2.

**前置 grill 记录:** `docs/superpowers/grills/2026-06-17-issue5-roll-choice.md`.

---

## 关键不变量

1. `rollChoice` never guesses workspace paths. It writes `logs/random-rolls.jsonl` under the passed `workspaceDir`.
2. `rollId` is caller-provided, required, and non-empty after trim. Issue 5 does not enforce global uniqueness.
3. Candidate `id` values are required, non-empty, and unique within one call.
4. Candidate `weight` values are finite positive numbers; `totalWeight` must also be finite and positive.
5. `rng` returns a finite number in `[0, 1)`. `NaN`, `Infinity`, negative values, and `>= 1` throw.
6. Single-candidate rolls are valid. `rollChoice` still calls RNG and records `sample`, but selected candidate is necessarily the only candidate.
7. `rollChoice` appends the random log before returning. If logging fails, it throws.
8. A runner must not write `turn/output.md` or `turn/done.json` after `rollChoice` throws; failure is left to `TurnOrchestrator` rollback.
9. Failed turns do not preserve random logs generated during the failed turn. Failure diagnosis still goes to `logs/turn-errors.log`.
10. Web/API responses remain sourced only from `turn/output.md`; `logs/random-rolls.jsonl` is never returned.
11. Issue 6 may add a CLI wrapper or equivalent shell-callable adapter around this module for Claude Code Runner; Issue 5 does not define CLI argument syntax.

---

## File Structure

```
src/lib/
└── random-tool.ts                 # New: rollChoice contract, weighted selection, RNG validation, JSONL append

tests/lib/
├── random-tool.test.ts            # New: unit contract tests for validation, selection, logging, workspaceDir use
└── random-tool-integration.test.ts # New: TurnOrchestrator seam tests with test-only random runner

tests/api/story-turn.test.ts       # Modify: add explicit random-rolls.jsonl non-leak regression

README.md                         # Modify after implementation: current state includes Issue 5 random tool seam
docs/issue.md                     # Modify after implementation: mark Issue 5 implementation/test status
```

**No new files:**

- No `src/app/api/random/route.ts`.
- No CLI wrapper.
- No changes to `src/lib/fake-agent-runner.ts`.
- No changes to `src/lib/turn-orchestrator.ts` for narrative/log consistency validation.

---

## Task 1: Random Tool Contract Tests

**Files:**
- Create: `tests/lib/random-tool.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/lib/random-tool.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  RANDOM_ROLLS_LOG,
  rollChoice,
  type RollChoiceCandidate,
} from "@/lib/random-tool";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;

beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});

afterAll(() => resetWorkspaceRoot());

function fixedRng(sample: number): () => number {
  return () => sample;
}

async function readRandomLogs(storyId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(
    path.join(root, storyId, "logs", RANDOM_ROLLS_LOG),
    "utf8",
  );
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const LOCKPICK_CANDIDATES: RollChoiceCandidate[] = [
  { id: "success", label: "撬锁成功", weight: 25 },
  { id: "fail", label: "撬锁失败", weight: 75 },
];

describe("rollChoice", () => {
  it("selects a weighted candidate and appends a random log", async () => {
    const meta = await createStory({ title: "random contract" });
    const result = await rollChoice({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      rollId: "lockpick-outcome",
      candidates: LOCKPICK_CANDIDATES,
      rng: fixedRng(0.1),
    });

    expect(result).toEqual({
      rollId: "lockpick-outcome",
      selectedId: "success",
      selectedCandidate: LOCKPICK_CANDIDATES[0],
      sample: 0.1,
      randomSource: "injected",
    });

    const logs = await readRandomLogs(meta.storyId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      storyId: meta.storyId,
      rollId: "lockpick-outcome",
      type: "roll-choice",
      selectedId: "success",
      randomSource: "injected",
      sample: 0.1,
      candidates: LOCKPICK_CANDIDATES,
    });
    expect(typeof logs[0].at).toBe("string");
  });

  it("uses the passed workspaceDir instead of resolving WORKSPACE_ROOT", async () => {
    const meta = await createStory({ title: "workspaceDir contract" });
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    const previousRoot = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = path.join(root, "wrong-root");
    try {
      await rollChoice({
        storyId: meta.storyId,
        workspaceDir,
        rollId: "workspace-dir-check",
        candidates: LOCKPICK_CANDIDATES,
        rng: fixedRng(0.9),
      });
    } finally {
      if (previousRoot === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = previousRoot;
    }

    const raw = await fs.readFile(
      path.join(workspaceDir, "logs", RANDOM_ROLLS_LOG),
      "utf8",
    );
    expect(raw).toContain("workspace-dir-check");
    expect(raw).toContain("fail");
  });

  it("allows a single candidate while still calling rng and recording sample", async () => {
    const meta = await createStory({ title: "single candidate" });
    let calls = 0;
    const result = await rollChoice({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      rollId: "single-candidate",
      candidates: [{ id: "only", label: "唯一结果", weight: 1 }],
      rng: () => {
        calls += 1;
        return 0.99;
      },
    });

    expect(calls).toBe(1);
    expect(result.selectedId).toBe("only");
    expect(result.sample).toBe(0.99);
    const logs = await readRandomLogs(meta.storyId);
    expect(logs[0]).toMatchObject({
      rollId: "single-candidate",
      selectedId: "only",
      sample: 0.99,
    });
  });

  it("rejects missing or blank rollId", async () => {
    const meta = await createStory();
    await expect(
      rollChoice({
        storyId: meta.storyId,
        workspaceDir: resolveWorkspaceDir(meta.storyId),
        rollId: "  ",
        candidates: LOCKPICK_CANDIDATES,
        rng: fixedRng(0.1),
      }),
    ).rejects.toThrow("rollId");
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0.01,
    1,
  ])("rejects invalid rng sample %s", async (sample) => {
    const meta = await createStory();
    await expect(
      rollChoice({
        storyId: meta.storyId,
        workspaceDir: resolveWorkspaceDir(meta.storyId),
        rollId: "invalid-rng",
        candidates: LOCKPICK_CANDIDATES,
        rng: fixedRng(sample),
      }),
    ).rejects.toThrow("rng sample");
  });

  it("rejects invalid candidates and non-finite totalWeight", async () => {
    const meta = await createStory();
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    const cases: Array<{ name: string; candidates: RollChoiceCandidate[] }> = [
      { name: "empty candidates", candidates: [] },
      {
        name: "duplicate id",
        candidates: [
          { id: "same", weight: 1 },
          { id: "same", weight: 2 },
        ],
      },
      { name: "blank id", candidates: [{ id: " ", weight: 1 }] },
      { name: "zero weight", candidates: [{ id: "zero", weight: 0 }] },
      { name: "negative weight", candidates: [{ id: "negative", weight: -1 }] },
      { name: "NaN weight", candidates: [{ id: "nan", weight: Number.NaN }] },
      {
        name: "Infinity weight",
        candidates: [{ id: "infinity", weight: Number.POSITIVE_INFINITY }],
      },
      {
        name: "non-finite totalWeight",
        candidates: [
          { id: "huge-a", weight: Number.MAX_VALUE },
          { id: "huge-b", weight: Number.MAX_VALUE },
        ],
      },
    ];

    for (const c of cases) {
      await expect(
        rollChoice({
          storyId: meta.storyId,
          workspaceDir,
          rollId: `invalid-${c.name}`,
          candidates: c.candidates,
          rng: fixedRng(0.1),
        }),
      ).rejects.toThrow();
    }
  });

  it("throws when random log cannot be appended", async () => {
    const meta = await createStory();
    await expect(
      rollChoice({
        storyId: meta.storyId,
        workspaceDir: path.join(resolveWorkspaceDir(meta.storyId), "story.md"),
        rollId: "log-write-failure",
        candidates: LOCKPICK_CANDIDATES,
        rng: fixedRng(0.1),
      }),
    ).rejects.toThrow("random log");
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
pnpm test tests/lib/random-tool.test.ts
```

Expected: FAIL because `@/lib/random-tool` does not exist.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/lib/random-tool.test.ts
git commit -m "test(random): specify rollChoice contract"
```

---

## Task 2: Implement `src/lib/random-tool.ts`

**Files:**
- Create: `src/lib/random-tool.ts`

- [ ] **Step 1: Add the implementation**

Create `src/lib/random-tool.ts`:

```typescript
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isValidStoryId } from "./workspace";

export const RANDOM_ROLLS_LOG = "random-rolls.jsonl";

export type RandomSource = "crypto" | "injected";

export type RollChoiceRng = () => number;

export interface RollChoiceCandidate {
  id: string;
  label?: string;
  weight: number;
}

export interface RollChoiceInput {
  storyId: string;
  workspaceDir: string;
  rollId: string;
  candidates: RollChoiceCandidate[];
  rng?: RollChoiceRng;
}

export interface RollChoiceResult {
  rollId: string;
  selectedId: string;
  selectedCandidate: RollChoiceCandidate;
  sample: number;
  randomSource: RandomSource;
}

interface NormalizedCandidates {
  candidates: RollChoiceCandidate[];
  totalWeight: number;
}

export async function rollChoice(input: RollChoiceInput): Promise<RollChoiceResult> {
  if (!isValidStoryId(input.storyId)) {
    throw new Error("invalid storyId");
  }
  if (typeof input.workspaceDir !== "string" || input.workspaceDir.trim() === "") {
    throw new Error("workspaceDir is required");
  }
  const rollId = normalizeRollId(input.rollId);
  const { candidates, totalWeight } = normalizeCandidates(input.candidates);
  const randomSource: RandomSource = input.rng ? "injected" : "crypto";
  const sample = input.rng ? input.rng() : cryptoSample();
  assertValidSample(sample);

  const selectedCandidate = selectCandidate(candidates, totalWeight, sample);
  const result: RollChoiceResult = {
    rollId,
    selectedId: selectedCandidate.id,
    selectedCandidate,
    sample,
    randomSource,
  };

  await appendRandomLog(input.storyId, input.workspaceDir, result, candidates);
  return result;
}

function normalizeRollId(raw: string): string {
  if (typeof raw !== "string") throw new Error("rollId is required");
  const rollId = raw.trim();
  if (!rollId) throw new Error("rollId is required");
  return rollId;
}

function normalizeCandidates(raw: RollChoiceCandidate[]): NormalizedCandidates {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("candidates must be a non-empty array");
  }

  const ids = new Set<string>();
  let totalWeight = 0;
  const candidates = raw.map((candidate) => {
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
      throw new Error("candidate id is required");
    }
    const id = candidate.id.trim();
    if (ids.has(id)) throw new Error(`duplicate candidate id: ${id}`);
    ids.add(id);

    if (
      typeof candidate.weight !== "number" ||
      !Number.isFinite(candidate.weight) ||
      candidate.weight <= 0
    ) {
      throw new Error(`candidate weight must be a finite positive number: ${id}`);
    }

    if (candidate.label !== undefined && typeof candidate.label !== "string") {
      throw new Error(`candidate label must be a string when provided: ${id}`);
    }

    totalWeight += candidate.weight;
    return {
      id,
      ...(candidate.label !== undefined ? { label: candidate.label } : {}),
      weight: candidate.weight,
    };
  });

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new Error("totalWeight must be a finite positive number");
  }

  return { candidates, totalWeight };
}

function assertValidSample(sample: number): void {
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("rng sample must be a finite number in [0, 1)");
  }
}

function cryptoSample(): number {
  const bytes = crypto.randomBytes(6);
  return bytes.readUIntBE(0, 6) / 0x1000000000000;
}

function selectCandidate(
  candidates: RollChoiceCandidate[],
  totalWeight: number,
  sample: number,
): RollChoiceCandidate {
  if (candidates.length === 1) return candidates[0];

  const target = sample * totalWeight;
  let cumulative = 0;
  for (const candidate of candidates) {
    cumulative += candidate.weight;
    if (target < cumulative) return candidate;
  }
  return candidates[candidates.length - 1];
}

async function appendRandomLog(
  storyId: string,
  workspaceDir: string,
  result: RollChoiceResult,
  candidates: RollChoiceCandidate[],
): Promise<void> {
  const logsDir = path.join(workspaceDir, "logs");
  const logPath = path.join(logsDir, RANDOM_ROLLS_LOG);
  const line = JSON.stringify({
    at: new Date().toISOString(),
    storyId,
    rollId: result.rollId,
    type: "roll-choice",
    candidates,
    selectedId: result.selectedId,
    randomSource: result.randomSource,
    sample: result.sample,
  });

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(logPath, line + "\n", "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to append random log: ${detail}`);
  }
}
```

- [ ] **Step 2: Run the random tool tests**

Run:

```bash
pnpm test tests/lib/random-tool.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/random-tool.ts tests/lib/random-tool.test.ts
git commit -m "feat(random): add rollChoice random tool"
```

---

## Task 3: TurnOrchestrator Random Tool Seam Tests

**Files:**
- Create: `tests/lib/random-tool-integration.test.ts`

- [ ] **Step 1: Add test-only integration runners**

Create `tests/lib/random-tool-integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "@/lib/agent-runner";
import { rollChoice, RANDOM_ROLLS_LOG } from "@/lib/random-tool";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import {
  createStory,
  readTurnDone,
  readTurnOutput,
  resolveWorkspaceDir,
} from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;

beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});

afterAll(() => resetWorkspaceRoot());

async function readRandomLogs(storyId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(
    path.join(root, storyId, "logs", RANDOM_ROLLS_LOG),
    "utf8",
  );
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class RandomOutcomeRunner implements AgentRunner {
  constructor(private readonly rng: () => number) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    req.signal.throwIfAborted();
    const roll = await rollChoice({
      storyId: req.storyId,
      workspaceDir: req.workspaceDir,
      rollId: "lockpick-outcome",
      candidates: [
        { id: "success", label: "撬锁成功", weight: 25 },
        { id: "fail", label: "撬锁失败", weight: 75 },
      ],
      rng: this.rng,
    });
    req.signal.throwIfAborted();

    const visibleConsequence =
      roll.selectedId === "success"
        ? "锁簧轻响，门缝向内打开。"
        : "铁丝折断，锁孔里传出刺耳的刮擦声。";

    const turnDir = path.join(req.workspaceDir, "turn");
    await fs.writeFile(
      path.join(turnDir, "output.md"),
      [
        "# 主角视窗",
        "",
        `随机结果：${roll.selectedId}`,
        "",
        visibleConsequence,
        "",
      ].join("\n"),
    );
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

class BrokenRandomLogRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const logsPath = path.join(req.workspaceDir, "logs");
    await fs.rm(logsPath, { recursive: true, force: true });
    await fs.writeFile(logsPath, "not a directory");

    await rollChoice({
      storyId: req.storyId,
      workspaceDir: req.workspaceDir,
      rollId: "log-write-failure",
      candidates: [{ id: "only", weight: 1 }],
      rng: () => 0.5,
    });

    await fs.writeFile(path.join(req.workspaceDir, "turn", "output.md"), "should not happen");
    await fs.writeFile(
      path.join(req.workspaceDir, "turn", "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    return { success: true };
  }
}

describe("Random Tool + TurnOrchestrator integration", () => {
  it("binds a success roll to player-visible output and random log", async () => {
    const meta = await createStory({ title: "success roll" });
    const orchestrator = new TurnOrchestrator(new RandomOutcomeRunner(() => 0.1));

    const outcome = await orchestrator.executeTurn(meta.storyId, "我试着撬锁");

    expect(outcome.success).toBe(true);
    expect(outcome.playerResponse).toContain("随机结果：success");
    expect(outcome.playerResponse).toContain("门缝向内打开");
    expect(outcome.playerResponse).toBe(await readTurnOutput(meta.storyId));
    const logs = await readRandomLogs(meta.storyId);
    expect(logs[0]).toMatchObject({
      rollId: "lockpick-outcome",
      selectedId: "success",
    });
  });

  it("binds a failure roll to player-visible output and random log", async () => {
    const meta = await createStory({ title: "failure roll" });
    const orchestrator = new TurnOrchestrator(new RandomOutcomeRunner(() => 0.9));

    const outcome = await orchestrator.executeTurn(meta.storyId, "我试着撬锁");

    expect(outcome.success).toBe(true);
    expect(outcome.playerResponse).toContain("随机结果：fail");
    expect(outcome.playerResponse).toContain("铁丝折断");
    const logs = await readRandomLogs(meta.storyId);
    expect(logs[0]).toMatchObject({
      rollId: "lockpick-outcome",
      selectedId: "fail",
    });
  });

  it("invalid rng makes the turn fail and rollback without preserving random log", async () => {
    const meta = await createStory({ title: "invalid rng rollback" });
    const outputBefore = await readTurnOutput(meta.storyId);
    const orchestrator = new TurnOrchestrator(new RandomOutcomeRunner(() => 1));

    const outcome = await orchestrator.executeTurn(meta.storyId, "我试着撬锁");

    expect(outcome.success).toBe(false);
    expect(await readTurnOutput(meta.storyId)).toBe(outputBefore);
    expect(await readTurnDone(meta.storyId)).toBeNull();
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", RANDOM_ROLLS_LOG)),
    ).rejects.toThrow();
  });

  it("random log write failure rolls back and runner does not commit output or done", async () => {
    const meta = await createStory({ title: "log failure rollback" });
    const outputBefore = await readTurnOutput(meta.storyId);
    const orchestrator = new TurnOrchestrator(new BrokenRandomLogRunner());

    const outcome = await orchestrator.executeTurn(meta.storyId, "触发日志失败");

    expect(outcome.success).toBe(false);
    expect(await readTurnOutput(meta.storyId)).toBe(outputBefore);
    expect(await readTurnDone(meta.storyId)).toBeNull();
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", ".gitkeep")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", RANDOM_ROLLS_LOG)),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the integration tests**

Run:

```bash
pnpm test tests/lib/random-tool-integration.test.ts
```

Expected: PASS. These tests use the production `rollChoice` from Task 2 and test-only runners; no production runner changes are needed.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/random-tool-integration.test.ts
git commit -m "test(random): prove rollChoice turn integration"
```

---

## Task 4: Web/API Random Log Non-Leak Regression

**Files:**
- Modify: `tests/api/story-turn.test.ts`

- [ ] **Step 1: Add the explicit random log non-leak test**

In `tests/api/story-turn.test.ts`, add this test inside the first `describe("POST /api/story-turn ...")` block after the existing `logs/secret.md` non-leak test:

```typescript
  it("does not leak logs/random-rolls.jsonl through playerResponse", async () => {
    const storyId = await freshStory();
    const randomLogPath = path.join(
      resolveWorkspaceRoot(),
      storyId,
      "logs",
      "random-rolls.jsonl",
    );
    await fs.writeFile(
      randomLogPath,
      JSON.stringify({
        at: "2026-06-17T00:00:00.000Z",
        storyId,
        rollId: "secret-random-roll",
        type: "roll-choice",
        candidates: [{ id: "secret", label: "机密随机结果", weight: 1 }],
        selectedId: "secret",
        randomSource: "injected",
        sample: 0.42,
      }) + "\n",
    );

    const res = await POST(req({ storyId, input: "继续前进" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).not.toContain("secret-random-roll");
    expect(json.playerResponse).not.toContain("机密随机结果");
    expect(json.playerResponse).toBe(await readTurnOutput(storyId));
  });
```

- [ ] **Step 2: Run the API test file**

Run:

```bash
pnpm test tests/api/story-turn.test.ts
```

Expected: PASS. Default `FakeAgentRunner` remains unchanged and Web reads only `turn/output.md`.

- [ ] **Step 3: Commit**

```bash
git add tests/api/story-turn.test.ts
git commit -m "test(api): ensure random logs never leak"
```

---

## Task 5: Documentation Updates After Implementation

**Files:**
- Modify: `README.md`
- Modify: `docs/issue.md`

- [ ] **Step 1: Update README current state**

Replace the current state paragraph at the top of `README.md` with:

```markdown
当前仓库状态：**Issue 5 — 工具真随机 roll-choice seam**。
首页可创建/列出故事，进入故事页发送主角输入；后端按 storyId 定位独立 workspace，通过 Fake Agent 返回固定主角可见输出。
已具备单回合安全边界（串行、快照、失败回滚）和内部随机工具 seam；尚未接入初始化 agent 与真实 Claude Code agent runtime（属后续 issue）。
```

- [ ] **Step 2: Update README workspace layout**

In the Story Workspace layout block, change the logs line from:

```markdown
  logs/.gitkeep    # 占位（random log 目录）
```

to:

```markdown
  logs/.gitkeep    # 内部日志目录
  logs/random-rolls.jsonl # 随机判定日志（成功回合追加；不对用户可见）
```

Also keep the sentence below the layout:

```markdown
主角可见输出只来自 `turn/output.md`；Web 不读取 agent stdout、logs、world、player、actors。
```

- [ ] **Step 3: Update Issue 5 status in docs/issue.md**

Under Issue 5 (`### 5. 加入工具真随机：roll-choice 端到端验证`), insert this status block after `**User stories covered**`:

```markdown
**Status**: 实现 + 测试完成
- ✅ `rollChoice` 工具模块完成：候选项 + 权重、调用方提供 rollId、可注入 rng、生产 crypto 随机
- ✅ 成功随机判定追加写入 `logs/random-rolls.jsonl`（JSONL），Web/API 不返回 random log
- ✅ 集成测试证明随机结果可绑定到 `turn/output.md`
- ✅ 随机工具失败与 random log 写入失败触发 Orchestrator rollback
- ⏭️ 不做 CLI wrapper；Issue 6 接真实 Claude Code Runner 时再基于本模块增加 shell 调用方式
```

- [ ] **Step 4: Run documentation diff check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/issue.md
git commit -m "docs(random): update issue 5 status"
```

---

## Task 6: Full Verification

**Files:**
- No source changes unless a previous task exposed a defect.

- [ ] **Step 1: Run targeted random tests**

Run:

```bash
pnpm test tests/lib/random-tool.test.ts tests/lib/random-tool-integration.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run API regression tests**

Run:

```bash
pnpm test tests/api/story-turn.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Run TypeScript/build gate if environment supports it**

Run:

```bash
pnpm build
```

Expected: PASS in a normal Linux/Docker environment. If it fails on the known Windows symlink/standalone trace issue already documented in `docs/issue.md`, record the failure output and do not treat that local-only issue as an Issue 5 blocker.

- [ ] **Step 5: Final diff review**

Run:

```bash
git diff --stat HEAD
git diff --check
```

Expected: only Issue 5 random tool, tests, and docs are changed; `git diff --check` has no output.

- [ ] **Step 6: Commit verification-only fixes if any were needed**

If Step 1-5 required small fixes, commit them:

```bash
git add src/lib/random-tool.ts tests/lib/random-tool.test.ts tests/lib/random-tool-integration.test.ts tests/api/story-turn.test.ts README.md docs/issue.md
git commit -m "fix(random): address issue 5 verification"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

**Spec coverage:**

- Function contract (`storyId`, `workspaceDir`, `rollId`, `candidates`, optional `rng`) covered in Task 1 and Task 2.
- Output contract (`rollId`, `selectedId`, `selectedCandidate`, `sample`, `randomSource`) covered in Task 1 and Task 2.
- `workspaceDir` path ownership covered in Task 1 `uses the passed workspaceDir`.
- `rollId` non-empty and caller-provided covered in Task 1 and docs Task 5.
- RNG range validation covered in Task 1 and Task 3 rollback test.
- `totalWeight` finite positive covered in Task 1.
- Single-candidate RNG/sample behavior covered in Task 1.
- Random log append-before-return and append failure covered in Task 1 and Task 3.
- No CLI wrapper, Issue 6 leave-open note covered in Task 5.
- Web/API non-leak regression covered in Task 4.
- Accepted decisions preserved: default `FakeAgentRunner` unchanged, no `/api/random`, no Orchestrator narrative validation.

**Placeholder scan:** No placeholder markers or unspecified implementation steps are used.

**Type consistency:** `RollChoiceCandidate`, `RollChoiceInput`, `RollChoiceResult`, `RollChoiceRng`, and `RANDOM_ROLLS_LOG` names are consistent across tasks.
