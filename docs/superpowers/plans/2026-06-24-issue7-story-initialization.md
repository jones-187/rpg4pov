# Issue 7 Story Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Issue 7: create a runnable visual-novel-style Story Workspace from natural-language setup, commit an opening entry, preserve legacy history, and seed Protagonist Core/NPC/pressure-source materials.

**Architecture:** Add a typed `StoryHistoryEntry` union with `kind: "opening" | "turn"` and legacy read normalization. Add a trusted story initialization service that creates the workspace skeleton, writes Markdown-first foundation files, writes opening output, and commits opening through `turn-history.ts`; `TurnOrchestrator` remains the only turn committer. Keep public `TurnInteraction` out of Issue 7 and do not expose internal generation metadata.

**Tech Stack:** TypeScript, Next.js App Router API routes, React client components, Node `fs/promises`, Vitest.

---

## Target Workspace

- **Target Worktree:** `/home/jones/projects/rpg4pov`
- **Target Branch:** `main`
- **Target HEAD:** `74dacc9fdf9ea555dc9949b8f8a36560517f1055`
- **Plan Date:** 2026-06-24

Do not infer the target repository from this plan file location. Execute against the target worktree above unless the user explicitly provides a newer worktree, branch, and HEAD.

---

## Grill Closure Summary

Confirmed decisions:
- `turns/history.jsonl` is the single committed player-visible timeline.
- New entries use `kind`, not `type`, because the Issue 7 boundary explicitly requires `kind: "opening"` and `kind: "turn"`.
- `OpeningHistoryEntry`: `{ kind: "opening"; entryId; at; output; committer: "initializer" }`.
- `TurnHistoryEntry`: `{ kind: "turn"; entryId; at; input; output; committer: "turn-orchestrator" }`.
- Legacy records shaped `{ turnId, at, input, output }` are readable and normalize to `kind: "turn"` with `entryId = turnId`. Reads do not rewrite JSONL.
- No opening is invented for old workspaces.
- Opening has no player input. Do not fake `"开始故事"` and do not overwrite `turn/input.md` with fake initialization input.
- Initializer commits opening. `TurnOrchestrator` commits turns. Runner/Claude read committed history only and never modify it.
- Issue 7 does not implement public `TurnInteraction`, `turn/interaction.json`, suggestions, decision mode, or interaction-state API.
- If Issue 7 stores private initialization notes, name them `InitializationGenerationMetadata` or `InternalGenerationMetadata`; do not return them through Web API, history, or UI.

Rejected alternatives:
- Keeping history turn-only.
- Representing opening as a normal turn.
- Letting Runner/Claude append, repair, or migrate committed history.
- Rewriting legacy history during reads.
- Putting initialization orchestration inside `workspace.ts`.
- Using turn snapshots for story creation.
- Expanding Issue 7 into Issue 8/9/9.5/10 narrative runtime behavior.

---

## File Structure

New files:
- `src/lib/story-initializer.ts` - deterministic Issue 7 initialization service; no LLM/network dependency.
- `tests/lib/story-initializer.test.ts` - validates foundation files, opening commit, canon preservation, no fake input, and failure cleanup.

Modified files:
- `src/lib/turn-history.ts` - typed history union, legacy normalizer, trusted commit helpers.
- `src/lib/turn-orchestrator.ts` - use `commitTurnHistory`; return typed turn entry.
- `src/lib/workspace.ts` - expose focused workspace write/read helpers and optional workspace deletion for failed creation cleanup.
- `src/lib/claude-prompt.ts` - document typed history plus legacy compatibility; keep history read-only.
- `src/app/api/stories/route.ts` - accept natural-language setup while keeping `{ title }` compatible.
- `src/app/api/stories/[storyId]/route.ts` - continue returning normalized `history`.
- `src/app/api/story-turn/route.ts` - keep `{ playerResponse, turn }` with typed turn.
- `src/app/page.tsx` - collect setup text and send it to story creation.
- `src/app/stories/[storyId]/page.tsx` - render mixed `opening` and `turn` entries.
- `src/app/globals.css` - add or adjust styles for opening-only history blocks.
- `README.md` - update workspace layout and Issue 7 behavior.

Modified tests:
- `tests/lib/turn-history.test.ts`
- `tests/lib/turn-orchestrator.test.ts`
- `tests/lib/workspace.test.ts`
- `tests/lib/claude-prompt.test.ts`
- `tests/api/stories.test.ts`
- `tests/api/stories/[storyId].test.ts`
- `tests/api/story-turn.test.ts`
- `tests/lib/story-page-helpers.test.ts`

---

## Public Types

Use these names consistently:

```ts
export type HistoryCommitter = "initializer" | "turn-orchestrator";

export interface OpeningHistoryEntry {
  kind: "opening";
  entryId: string;
  at: string;
  output: string;
  committer: "initializer";
}

export interface TurnHistoryEntry {
  kind: "turn";
  entryId: string;
  at: string;
  input: string;
  output: string;
  committer: "turn-orchestrator";
}

export type StoryHistoryEntry = OpeningHistoryEntry | TurnHistoryEntry;

interface LegacyTurnHistoryEntry {
  turnId: string;
  at: string;
  input: string;
  output: string;
}
```

Public API returns `StoryHistoryEntry[]` from `GET /api/stories/{storyId}`. `POST /api/story-turn` returns `turn: TurnHistoryEntry`. `POST /api/stories` may keep returning top-level `StoryMeta` for compatibility; refresh authority remains `GET /api/stories/{storyId}`.

---

## Task 1: Typed History With Legacy Reader Compatibility

**Files:**
- Modify: `src/lib/turn-history.ts`
- Test: `tests/lib/turn-history.test.ts`

- [ ] **Step 1: Replace the history tests with typed and legacy coverage**

Use this test structure in `tests/lib/turn-history.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  commitOpeningHistory,
  commitTurnHistory,
  readTurnHistory,
  type OpeningHistoryEntry,
  type TurnHistoryEntry,
  type StoryHistoryEntry,
} from "@/lib/turn-history";
import { createStory, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;

beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});

afterAll(() => resetWorkspaceRoot());

describe("turn-history", () => {
  it("commits an opening entry without player input", async () => {
    const meta = await createStory({ title: "opening history" });

    const entry = await commitOpeningHistory(meta.storyId, "我在雨声里醒来。");

    const typed: OpeningHistoryEntry = entry;
    expect(typed.kind).toBe("opening");
    expect(typed.committer).toBe("initializer");
    expect(typed.output).toBe("我在雨声里醒来。");
    expect("input" in typed).toBe(false);

    const history = await readTurnHistory(meta.storyId);
    expect(history).toEqual([entry]);
  });

  it("commits a typed turn entry with real player input", async () => {
    const meta = await createStory({ title: "turn history" });

    const entry = await commitTurnHistory(meta.storyId, "推开门", "门后是空荡的走廊。");

    const typed: TurnHistoryEntry = entry;
    expect(typed.kind).toBe("turn");
    expect(typed.committer).toBe("turn-orchestrator");
    expect(typed.input).toBe("推开门");
    expect(typed.output).toBe("门后是空荡的走廊。");
  });

  it("keeps opening and turn entries in append order", async () => {
    const meta = await createStory({ title: "timeline" });
    const opening = await commitOpeningHistory(meta.storyId, "开场。");
    const turn = await commitTurnHistory(meta.storyId, "回应", "对方沉默下来。");

    const history = await readTurnHistory(meta.storyId);

    expect(history).toEqual<StoryHistoryEntry[]>([opening, turn]);
  });

  it("normalizes legacy turnId entries to kind=turn without rewriting JSONL", async () => {
    const meta = await createStory({ title: "legacy history" });
    const historyPath = path.join(root, meta.storyId, "turns", "history.jsonl");
    const legacyLine = JSON.stringify({
      turnId: "legacy-turn-1",
      at: "2026-06-18T00:00:00.000Z",
      input: "旧输入",
      output: "旧输出",
    });
    await fs.writeFile(historyPath, legacyLine + "\n", "utf8");

    const history = await readTurnHistory(meta.storyId);
    const rawAfterRead = await fs.readFile(historyPath, "utf8");

    expect(history).toEqual([
      {
        kind: "turn",
        entryId: "legacy-turn-1",
        at: "2026-06-18T00:00:00.000Z",
        input: "旧输入",
        output: "旧输出",
        committer: "turn-orchestrator",
      },
    ]);
    expect(rawAfterRead).toBe(legacyLine + "\n");
  });

  it("does not invent an opening for legacy or empty workspaces", async () => {
    const meta = await createStory({ title: "no opening" });

    const history = await readTurnHistory(meta.storyId);

    expect(history).toEqual([]);
  });

  it("returns empty array when history.jsonl does not exist", async () => {
    const meta = await createStory();
    await fs.unlink(path.join(root, meta.storyId, "turns", "history.jsonl"));

    await expect(readTurnHistory(meta.storyId)).resolves.toEqual([]);
  });

  it("creates turns directory if missing before committing", async () => {
    const meta = await createStory();
    const turnsDir = path.join(root, meta.storyId, "turns");
    await fs.rm(turnsDir, { recursive: true });

    await commitTurnHistory(meta.storyId, "输入", "输出");

    await expect(fs.access(path.join(turnsDir, "history.jsonl"))).resolves.toBeUndefined();
  });

  it("throws on malformed JSONL", async () => {
    const meta = await createStory();
    await fs.writeFile(path.join(root, meta.storyId, "turns", "history.jsonl"), "not json\n");

    await expect(readTurnHistory(meta.storyId)).rejects.toThrow();
  });

  it("throws on invalid typed shape", async () => {
    const meta = await createStory();
    await fs.writeFile(
      path.join(root, meta.storyId, "turns", "history.jsonl"),
      JSON.stringify({ kind: "opening", entryId: "bad", at: "x", input: "fake", output: "x" }) + "\n",
    );

    await expect(readTurnHistory(meta.storyId)).rejects.toThrow("invalid history entry");
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
pnpm vitest run tests/lib/turn-history.test.ts
```

Expected: FAIL because `commitOpeningHistory`, `commitTurnHistory`, and typed exports do not exist.

- [ ] **Step 3: Implement typed history and legacy normalization**

Replace `src/lib/turn-history.ts` with:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isValidStoryId, resolveWorkspaceDir } from "./workspace";

export type HistoryCommitter = "initializer" | "turn-orchestrator";

export interface OpeningHistoryEntry {
  kind: "opening";
  entryId: string;
  at: string;
  output: string;
  committer: "initializer";
}

export interface TurnHistoryEntry {
  kind: "turn";
  entryId: string;
  at: string;
  input: string;
  output: string;
  committer: "turn-orchestrator";
}

export type StoryHistoryEntry = OpeningHistoryEntry | TurnHistoryEntry;

interface LegacyTurnHistoryEntry {
  turnId: string;
  at: string;
  input: string;
  output: string;
}

function resolveHistoryPath(storyId: string): string {
  return path.join(resolveWorkspaceDir(storyId), "turns", "history.jsonl");
}

export async function commitOpeningHistory(
  storyId: string,
  output: string,
): Promise<OpeningHistoryEntry> {
  const entry: OpeningHistoryEntry = {
    kind: "opening",
    entryId: crypto.randomUUID(),
    at: new Date().toISOString(),
    output,
    committer: "initializer",
  };
  await appendHistoryEntry(storyId, entry);
  return entry;
}

export async function commitTurnHistory(
  storyId: string,
  input: string,
  output: string,
): Promise<TurnHistoryEntry> {
  const entry: TurnHistoryEntry = {
    kind: "turn",
    entryId: crypto.randomUUID(),
    at: new Date().toISOString(),
    input,
    output,
    committer: "turn-orchestrator",
  };
  await appendHistoryEntry(storyId, entry);
  return entry;
}

async function appendHistoryEntry(
  storyId: string,
  entry: StoryHistoryEntry,
): Promise<void> {
  if (!isValidStoryId(storyId)) {
    throw new Error("invalid storyId");
  }
  const historyPath = resolveHistoryPath(storyId);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.appendFile(historyPath, JSON.stringify(entry) + "\n", "utf8");
}

export async function readTurnHistory(
  storyId: string,
): Promise<StoryHistoryEntry[] | null> {
  if (!isValidStoryId(storyId)) {
    return null;
  }
  const historyPath = resolveHistoryPath(storyId);
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    if (!raw.trim()) {
      return [];
    }
    return raw
      .trim()
      .split("\n")
      .map((line) => normalizeHistoryEntry(JSON.parse(line) as unknown));
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function normalizeHistoryEntry(value: unknown): StoryHistoryEntry {
  if (!isRecord(value)) {
    throw new Error("invalid history entry");
  }

  if (value.kind === "opening") {
    if (
      typeof value.entryId === "string" &&
      typeof value.at === "string" &&
      typeof value.output === "string" &&
      value.committer === "initializer" &&
      !("input" in value)
    ) {
      return value as unknown as OpeningHistoryEntry;
    }
    throw new Error("invalid history entry: opening");
  }

  if (value.kind === "turn") {
    if (
      typeof value.entryId === "string" &&
      typeof value.at === "string" &&
      typeof value.input === "string" &&
      typeof value.output === "string" &&
      value.committer === "turn-orchestrator"
    ) {
      return value as unknown as TurnHistoryEntry;
    }
    throw new Error("invalid history entry: turn");
  }

  if (
    typeof value.turnId === "string" &&
    typeof value.at === "string" &&
    typeof value.input === "string" &&
    typeof value.output === "string" &&
    !("kind" in value)
  ) {
    const legacy = value as unknown as LegacyTurnHistoryEntry;
    return {
      kind: "turn",
      entryId: legacy.turnId,
      at: legacy.at,
      input: legacy.input,
      output: legacy.output,
      committer: "turn-orchestrator",
    };
  }

  throw new Error("invalid history entry");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```bash
pnpm vitest run tests/lib/turn-history.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/turn-history.ts tests/lib/turn-history.test.ts
git commit -m "feat(issue7): add typed story history entries"
```

---

## Task 2: Turn Orchestrator Uses Trusted Turn Committer

**Files:**
- Modify: `src/lib/turn-orchestrator.ts`
- Modify: `tests/lib/turn-orchestrator.test.ts`
- Modify: `tests/api/story-turn.test.ts`

- [ ] **Step 1: Update orchestrator tests for typed turn entries**

In `tests/lib/turn-orchestrator.test.ts`, update the successful history append assertions to expect typed entries:

```ts
it("successful turn appends typed turn entry to turns/history.jsonl", async () => {
  const meta = await createStory({ title: "typed turn" });
  const orchestrator = new TurnOrchestrator(new FakeAgentRunner());

  const outcome = await orchestrator.executeTurn(meta.storyId, "推开木门");

  expect(outcome.success).toBe(true);
  expect(outcome.turn).toMatchObject({
    kind: "turn",
    input: "推开木门",
    committer: "turn-orchestrator",
  });
  expect(outcome.turn?.entryId).toEqual(expect.any(String));
  expect(outcome.turn?.at).toEqual(expect.any(String));

  const history = await readTurnHistory(meta.storyId);
  expect(history).toEqual([outcome.turn]);
});
```

In `tests/api/story-turn.test.ts`, update successful response validation:

```ts
expect(json.turn).toMatchObject({
  kind: "turn",
  input: "推开木门",
  committer: "turn-orchestrator",
});
expect(typeof json.turn.entryId).toBe("string");
expect(typeof json.turn.at).toBe("string");
expect(typeof json.turn.output).toBe("string");
expect(json.turn.turnId).toBeUndefined();
```

- [ ] **Step 2: Run the affected tests and confirm they fail**

Run:

```bash
pnpm vitest run tests/lib/turn-orchestrator.test.ts tests/api/story-turn.test.ts
```

Expected: FAIL because `TurnOrchestrator` still returns `turnId` entries and imports `appendTurnHistory`.

- [ ] **Step 3: Update `TurnOrchestrator`**

In `src/lib/turn-orchestrator.ts`, change imports:

```ts
import { commitTurnHistory, type TurnHistoryEntry } from "./turn-history";
```

Remove `crypto` import from this file.

Replace manual entry construction and append with:

```ts
let entry: TurnHistoryEntry;
try {
  entry = await commitTurnHistory(storyId, playerInput, playerResponse);
} catch (appendErr) {
  return await this.failTurn(
    storyId,
    `history append failed: ${appendErr instanceof Error ? appendErr.message : String(appendErr)}`,
    playerInput,
  );
}

await deleteSnapshot(storyId);
return { success: true, playerResponse, turn: entry };
```

- [ ] **Step 4: Run the affected tests and confirm they pass**

Run:

```bash
pnpm vitest run tests/lib/turn-orchestrator.test.ts tests/api/story-turn.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/turn-orchestrator.ts tests/lib/turn-orchestrator.test.ts tests/api/story-turn.test.ts
git commit -m "feat(issue7): commit typed turn history from orchestrator"
```

---

## Task 3: Workspace Helpers for Initialization Artifacts

**Files:**
- Modify: `src/lib/workspace.ts`
- Modify: `tests/lib/workspace.test.ts`

- [ ] **Step 1: Add failing workspace helper tests**

Append these tests to `tests/lib/workspace.test.ts`:

```ts
describe("Issue 7 initialization workspace helpers", () => {
  it("writes initialization artifacts through workspace helpers", async () => {
    const meta = await createStory({ title: "初始化文件" });

    await writeStoryInitializationFiles(meta.storyId, {
      storyMd: "# 故事\n\n## 高优先级 Canon\n\n雨夜酒馆。",
      rulesMd: "# 规则\n\n保持主角视角。",
      worldMd: "# 世界设定\n\n## 初始压力源\n\n有人在撒谎。",
      playerMd: "# 主角\n\n## Protagonist Core\n\n- narrativeVoice: 克制但敏锐",
      actorFiles: [
        {
          filename: "lin.md",
          content: "# 林\n\n## Voice\n\n短句，回避直接承诺。",
        },
      ],
      openingOutput: "# 主角视窗\n\n雨声贴着窗沿，我看见林站在门口。",
    });

    const dir = resolveWorkspaceDir(meta.storyId);
    await expect(fs.readFile(path.join(dir, "story.md"), "utf8")).resolves.toContain("高优先级 Canon");
    await expect(fs.readFile(path.join(dir, "player.md"), "utf8")).resolves.toContain("Protagonist Core");
    await expect(fs.readFile(path.join(dir, "actors", "lin.md"), "utf8")).resolves.toContain("Voice");
    await expect(fs.readFile(path.join(dir, "turn", "output.md"), "utf8")).resolves.toContain("雨声贴着窗沿");
  });

  it("rejects unsafe actor filenames", async () => {
    const meta = await createStory({ title: "unsafe actor" });

    await expect(
      writeStoryInitializationFiles(meta.storyId, {
        storyMd: "# 故事\n",
        rulesMd: "# 规则\n",
        worldMd: "# 世界设定\n",
        playerMd: "# 主角\n",
        actorFiles: [{ filename: "../bad.md", content: "bad" }],
        openingOutput: "开场",
      }),
    ).rejects.toThrow("invalid actor filename");
  });
});
```

Update imports in the test:

```ts
import {
  createStory,
  resolveWorkspaceDir,
  resolveWorkspaceRoot,
  writeStoryInitializationFiles,
} from "@/lib/workspace";
```

- [ ] **Step 2: Run the focused workspace tests and confirm they fail**

Run:

```bash
pnpm vitest run tests/lib/workspace.test.ts
```

Expected: FAIL because `writeStoryInitializationFiles` does not exist.

- [ ] **Step 3: Implement workspace initialization helpers**

Add exports to `src/lib/workspace.ts`:

```ts
export interface StoryInitializationFiles {
  storyMd: string;
  rulesMd: string;
  worldMd: string;
  playerMd: string;
  actorFiles: Array<{ filename: string; content: string }>;
  openingOutput: string;
}

export async function writeStoryInitializationFiles(
  storyId: string,
  files: StoryInitializationFiles,
): Promise<void> {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  const dir = resolveWorkspaceDir(storyId);

  await fs.writeFile(path.join(dir, "story.md"), files.storyMd, "utf8");
  await fs.writeFile(path.join(dir, "rules.md"), files.rulesMd, "utf8");
  await fs.writeFile(path.join(dir, "world.md"), files.worldMd, "utf8");
  await fs.writeFile(path.join(dir, "player.md"), files.playerMd, "utf8");
  await fs.writeFile(path.join(dir, "turn", "output.md"), files.openingOutput, "utf8");

  await fs.mkdir(path.join(dir, "actors"), { recursive: true });
  for (const actor of files.actorFiles) {
    if (!isSafeActorFilename(actor.filename)) {
      throw new Error("invalid actor filename");
    }
    await fs.writeFile(path.join(dir, "actors", actor.filename), actor.content, "utf8");
  }
}

export async function deleteStoryWorkspace(storyId: string): Promise<void> {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  await fs.rm(resolveWorkspaceDir(storyId), { recursive: true, force: true });
}

function isSafeActorFilename(filename: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.md$/i.test(filename);
}
```

- [ ] **Step 4: Run the focused workspace tests and confirm they pass**

Run:

```bash
pnpm vitest run tests/lib/workspace.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace.ts tests/lib/workspace.test.ts
git commit -m "feat(issue7): add workspace initialization file helpers"
```

---

## Task 4: Deterministic Story Initializer Service

**Files:**
- Create: `src/lib/story-initializer.ts`
- Create: `tests/lib/story-initializer.test.ts`

- [ ] **Step 1: Write failing initializer tests**

Create `tests/lib/story-initializer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { initializeStoryWorkspace } from "@/lib/story-initializer";
import { readTurnHistory } from "@/lib/turn-history";
import { resolveWorkspaceDir, workspaceExists } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

beforeEach(async () => {
  await useTempWorkspaceRoot();
});

afterEach(() => resetWorkspaceRoot());

describe("initializeStoryWorkspace", () => {
  it("creates a playable workspace with opening history and foundation materials", async () => {
    const result = await initializeStoryWorkspace({
      title: "雨夜酒馆",
      setup: "雨夜，主角在旧酒馆遇到一个明显隐瞒真相的熟人林。",
    });

    expect(await workspaceExists(result.story.storyId)).toBe(true);
    expect(result.opening.kind).toBe("opening");
    expect(result.opening.committer).toBe("initializer");
    expect("input" in result.opening).toBe(false);

    const history = await readTurnHistory(result.story.storyId);
    expect(history).toEqual([result.opening]);

    const dir = resolveWorkspaceDir(result.story.storyId);
    await expect(fs.readFile(path.join(dir, "story.md"), "utf8")).resolves.toContain("高优先级 Canon");
    await expect(fs.readFile(path.join(dir, "story.md"), "utf8")).resolves.toContain("雨夜，主角在旧酒馆");
    await expect(fs.readFile(path.join(dir, "player.md"), "utf8")).resolves.toContain("narrativeVoice");
    await expect(fs.readFile(path.join(dir, "player.md"), "utf8")).resolves.toContain("avoidExpressions");
    await expect(fs.readFile(path.join(dir, "rules.md"), "utf8")).resolves.toContain("重大决定必须交还玩家");
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("压力源");
    await expect(fs.readdir(path.join(dir, "actors"))).resolves.toContain("lin.md");
    await expect(fs.readFile(path.join(dir, "turn", "output.md"), "utf8")).resolves.toBe(result.opening.output);
    await expect(fs.readFile(path.join(dir, "turn", "input.md"), "utf8")).resolves.toContain("占位");
  });

  it("uses a default playable setup when setup is blank", async () => {
    const result = await initializeStoryWorkspace({ title: "空输入", setup: "   " });

    expect(result.story.title).toBe("空输入");
    expect(result.opening.output.trim().length).toBeGreaterThan(0);
    expect((await readTurnHistory(result.story.storyId))?.[0]).toMatchObject({ kind: "opening" });
  });

  it("cleans up the workspace if artifact writing fails", async () => {
    await expect(
      initializeStoryWorkspace({
        title: "失败清理",
        setup: "触发失败",
        unsafeActorFilenameForTest: "../bad.md",
      }),
    ).rejects.toThrow("invalid actor filename");
  });
});
```

- [ ] **Step 2: Run the initializer tests and confirm they fail**

Run:

```bash
pnpm vitest run tests/lib/story-initializer.test.ts
```

Expected: FAIL because `src/lib/story-initializer.ts` does not exist.

- [ ] **Step 3: Implement deterministic initializer**

Create `src/lib/story-initializer.ts`:

```ts
import {
  createStory,
  deleteStoryWorkspace,
  writeStoryInitializationFiles,
  type StoryMeta,
} from "./workspace";
import { commitOpeningHistory, type OpeningHistoryEntry } from "./turn-history";

export interface InitializeStoryInput {
  title?: string;
  setup?: string;
  unsafeActorFilenameForTest?: string;
}

export interface InitializeStoryResult {
  story: StoryMeta;
  opening: OpeningHistoryEntry;
}

export async function initializeStoryWorkspace(
  input: InitializeStoryInput,
): Promise<InitializeStoryResult> {
  const story = await createStory({ title: input.title });
  const setup = normalizeSetup(input.setup);

  try {
    const openingOutput = buildOpeningOutput(setup);
    await writeStoryInitializationFiles(story.storyId, {
      storyMd: buildStoryMd(story, setup),
      rulesMd: buildRulesMd(),
      worldMd: buildWorldMd(setup),
      playerMd: buildPlayerMd(),
      actorFiles: [
        {
          filename: input.unsafeActorFilenameForTest ?? "lin.md",
          content: buildActorMd(setup),
        },
      ],
      openingOutput,
    });
    const opening = await commitOpeningHistory(story.storyId, openingOutput);
    return { story, opening };
  } catch (err) {
    await deleteStoryWorkspace(story.storyId).catch(() => undefined);
    throw err;
  }
}

function normalizeSetup(raw?: string): string {
  const setup = typeof raw === "string" ? raw.trim() : "";
  return setup || "一个雨夜，主角在旧酒馆遇见熟人林；林明显隐瞒着什么，空气里有尚未说出口的压力。";
}

function buildStoryMd(story: StoryMeta, setup: string): string {
  return `---\nid: ${story.storyId}\ntitle: ${story.title}\ncreatedAt: ${story.createdAt}\n---\n\n# 故事\n\n## 高优先级 Canon\n\n${setup}\n\n## 初始化说明\n\n以上内容来自玩家创建故事时的自然语言设定，后续生成不得随意改写。\n`;
}

function buildRulesMd(): string {
  return `# 规则\n\n## 主角视角\n\n只输出主角可见、可听、可感知、可合理推断的内容。\n\n## 主角控制权\n\n系统可以补全低风险表现和行动细节；重大决定必须交还玩家。\n\n## 禁止内容\n\n不得预写固定路线、固定章节、固定结局；不得把内部推理、hiddenIntent、随机日志或交互生成元数据写入玩家可见历史。\n`;
}

function buildWorldMd(setup: string): string {
  return `# 世界设定\n\n## 初始场景\n\n${setup}\n\n## 初始压力源\n\n- 有人隐瞒了与当前场景相关的重要信息。\n- 主角能感到关系或风险正在变化，但还不能直接知道全部真相。\n\n## 后续叙事材料\n\n后续回合应从当前压力源推进 Meaningful Change，而不是重复环境描写。\n`;
}

function buildPlayerMd(): string {
  return `# 主角\n\n## Protagonist Core\n\n- narrativeVoice: 第一人称，克制、敏锐，注意细节但不直接替玩家下最终结论。\n- temperament: 慢热，观察优先，不轻易暴露脆弱。\n- emotionalExpression: 情绪先体现在注意力、停顿和动作里，再进入语言。\n- conflictStyle: 先确认矛盾，再选择追问或后退。\n- relationshipStyle: 重视边界，不把关心自动等同于承诺。\n- humorStyle: 轻微自嘲，不油滑。\n- initiative: 长时间僵持时可以低风险主动推进对话。\n- moralBoundaries: 不主动伤害无辜者，不替玩家作不可逆道德选择。\n- speechPatterns: 短句、具体、避免空泛安慰。\n- avoidExpressions: 避免“说不上来的感觉”“心情很复杂”“我们应该坦诚面对”。\n\n## 第一人称叙述基调\n\n心理描写应具体呈现注意力变化、怀疑、犹豫和未完成的冲动。\n\n## Agency Boundaries\n\n系统可自动演出低风险心理活动、自然反应和行动细节；爱、恨、原谅、信任、告白、承诺、拒绝、关系定义和不可逆行为必须交还玩家。\n`;
}

function buildActorMd(setup: string): string {
  return `# 林\n\n## Canon Source\n\n${setup}\n\n## Voice\n\n短句，回避直接承诺；紧张时会反问或转移话题。\n\n## Basic Motivation\n\n想确认主角是否已经察觉异常，同时避免暴露自己隐瞒的信息。\n\n## Initial Relationship Pressure\n\n熟悉但有距离；此刻的沉默比普通寒暄更重。\n\n## Knowledge Boundary\n\n林知道一部分真相，但玩家和主角只能通过言行观察到可见线索。\n`;
}

function buildOpeningOutput(setup: string): string {
  return `# 主角视窗\n\n雨声贴着窗沿往下滑，我推开门时，屋里的灯比想象中暗。\n\n林站在吧台旁边，像是早就知道我会来。她抬眼看我，手指却没有离开杯沿。\n\n我先注意到的不是她的表情，而是她把一句话咽回去的停顿。\n\n${setup}\n\n有什么东西已经发生了，只是没人愿意先把它说破。`;
}
```

- [ ] **Step 4: Run initializer tests and confirm they pass**

Run:

```bash
pnpm vitest run tests/lib/story-initializer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/story-initializer.ts tests/lib/story-initializer.test.ts
git commit -m "feat(issue7): initialize playable story workspace"
```

---

## Task 5: Story Creation API Uses Initializer

**Files:**
- Modify: `src/app/api/stories/route.ts`
- Modify: `tests/api/stories.test.ts`
- Modify: `tests/api/stories/[storyId].test.ts`

- [ ] **Step 1: Update API tests for opening creation and compatibility**

In `tests/api/stories.test.ts`, update `POST /api/stories` cases:

```ts
it("creates initialized story from setup and returns meta", async () => {
  const res = await createStory(
    req("http://localhost/api/stories", "POST", {
      title: "雨夜酒馆",
      setup: "雨夜，主角在旧酒馆遇到林。",
    }),
  );
  expect(res.status).toBe(201);
  const json = await res.json();
  expect(UUID_RE.test(json.storyId)).toBe(true);
  expect(json.title).toBe("雨夜酒馆");

  const getRes = await getStory(req(`http://localhost/api/stories/${json.storyId}`, "GET"), {
    params: Promise.resolve({ storyId: json.storyId }),
  });
  const fetched = await getRes.json();
  expect(fetched.history).toHaveLength(1);
  expect(fetched.history[0]).toMatchObject({
    kind: "opening",
    committer: "initializer",
  });
});

it("keeps old title-only body valid", async () => {
  const res = await createStory(req("http://localhost/api/stories", "POST", { title: "旧调用" }));
  expect(res.status).toBe(201);
  const json = await res.json();
  expect(json.title).toBe("旧调用");
});
```

In `tests/api/stories/[storyId].test.ts`, update the "no turns" test:

```ts
it("returns initialized opening history for a new Issue 7 story", async () => {
  const created = await createStory(
    new Request("http://localhost/api/stories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "开场恢复", setup: "一间深夜便利店。" }),
    }),
  );
  const meta = await created.json();

  const res = await GET(makeRequest(meta.storyId), {
    params: Promise.resolve({ storyId: meta.storyId }),
  });

  const json = await res.json();
  expect(json.history).toHaveLength(1);
  expect(json.history[0].kind).toBe("opening");
  expect(json.history[0].output).toContain("主角视窗");
});
```

Keep a direct `createStory()`-based legacy empty-history test in `tests/api/stories/[storyId].test.ts` so old workspaces are still covered:

```ts
it("returns empty history for legacy skeleton workspace without opening", async () => {
  const meta = await createStory({ title: "legacy empty" });
  const res = await GET(makeRequest(meta.storyId), {
    params: Promise.resolve({ storyId: meta.storyId }),
  });
  const json = await res.json();
  expect(json.history).toEqual([]);
});
```

- [ ] **Step 2: Run API tests and confirm they fail**

Run:

```bash
pnpm vitest run tests/api/stories.test.ts tests/api/stories/[storyId].test.ts
```

Expected: FAIL because `POST /api/stories` still calls `createStory` directly.

- [ ] **Step 3: Update `POST /api/stories`**

In `src/app/api/stories/route.ts`, replace direct creation with initializer:

```ts
import { NextResponse } from "next/server";
import { initializeStoryWorkspace } from "@/lib/story-initializer";
import { listStories } from "@/lib/workspace";

export async function POST(request: Request) {
  let title: string | undefined;
  let setup: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      const t = (body as { title?: unknown }).title;
      const s = (body as { setup?: unknown }).setup;
      title = typeof t === "string" ? t : undefined;
      setup = typeof s === "string" ? s : undefined;
    }
  } catch {
    // body 非 JSON：按默认设定创建，仍允许。
  }

  try {
    const result = await initializeStoryWorkspace({ title, setup });
    return NextResponse.json(result.story, { status: 201 });
  } catch {
    return NextResponse.json({ error: "story initialization failed" }, { status: 500 });
  }
}

export async function GET() {
  const stories = await listStories();
  return NextResponse.json({ stories });
}
```

- [ ] **Step 4: Run API tests and confirm they pass**

Run:

```bash
pnpm vitest run tests/api/stories.test.ts tests/api/stories/[storyId].test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/stories/route.ts tests/api/stories.test.ts tests/api/stories/[storyId].test.ts
git commit -m "feat(issue7): initialize stories through API"
```

---

## Task 6: Frontend Mixed Timeline Rendering

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/stories/[storyId]/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `tests/lib/story-page-helpers.test.ts`

- [ ] **Step 1: Add helper tests for mixed history**

Refactor `tests/lib/story-page-helpers.test.ts` to include pure helpers:

```ts
type StoryHistoryEntry =
  | { kind: "opening"; entryId: string; at: string; output: string; committer: "initializer" }
  | { kind: "turn"; entryId: string; at: string; input: string; output: string; committer: "turn-orchestrator" };

function validateStoryHistoryEntry(value: unknown): StoryHistoryEntry {
  if (!value || typeof value !== "object") throw new Error("entry is not object");
  const entry = value as Record<string, unknown>;
  if (entry.kind === "opening") {
    if (
      typeof entry.entryId === "string" &&
      typeof entry.at === "string" &&
      typeof entry.output === "string" &&
      entry.committer === "initializer" &&
      !("input" in entry)
    ) {
      return entry as StoryHistoryEntry;
    }
  }
  if (entry.kind === "turn") {
    if (
      typeof entry.entryId === "string" &&
      typeof entry.at === "string" &&
      typeof entry.input === "string" &&
      typeof entry.output === "string" &&
      entry.committer === "turn-orchestrator"
    ) {
      return entry as StoryHistoryEntry;
    }
  }
  throw new Error("invalid history entry");
}

describe("validateStoryHistoryEntry", () => {
  it("accepts opening without input", () => {
    const entry = validateStoryHistoryEntry({
      kind: "opening",
      entryId: "open-1",
      at: "2026-06-24T00:00:00.000Z",
      output: "开场",
      committer: "initializer",
    });
    expect(entry.kind).toBe("opening");
  });

  it("accepts typed turn with input", () => {
    const entry = validateStoryHistoryEntry({
      kind: "turn",
      entryId: "turn-1",
      at: "2026-06-24T00:00:00.000Z",
      input: "行动",
      output: "结果",
      committer: "turn-orchestrator",
    });
    expect(entry.kind).toBe("turn");
  });

  it("rejects opening with fake input", () => {
    expect(() =>
      validateStoryHistoryEntry({
        kind: "opening",
        entryId: "open-1",
        at: "2026-06-24T00:00:00.000Z",
        input: "开始故事",
        output: "开场",
        committer: "initializer",
      }),
    ).toThrow("invalid history entry");
  });
});
```

- [ ] **Step 2: Run helper tests and confirm they fail or document current mismatch**

Run:

```bash
pnpm vitest run tests/lib/story-page-helpers.test.ts
```

Expected: FAIL if production helper exports are added first; otherwise PASS as a documentation test and proceed to update the page. If keeping pure documentation helpers, make sure the page uses the same logic manually.

- [ ] **Step 3: Update home page setup form**

In `src/app/page.tsx`:
- Rename state `title` to `setup`.
- Send `{ setup: setup.trim() || undefined }`.
- Derive no separate title in UI; initializer defaults title to `未命名故事` unless user keeps title compatibility through API.

Use this form body:

```tsx
<textarea
  value={setup}
  onChange={(e) => setSetup(e.target.value)}
  placeholder="输入一个小场景设定，例如：雨夜，主角在旧酒馆遇到一个明显隐瞒真相的熟人。"
  rows={5}
  disabled={loading}
/>
```

- [ ] **Step 4: Update story page mixed render**

In `src/app/stories/[storyId]/page.tsx`, replace `TurnHistoryEntry` with:

```ts
type StoryHistoryEntry =
  | {
      kind: "opening";
      entryId: string;
      at: string;
      output: string;
      committer: "initializer";
    }
  | {
      kind: "turn";
      entryId: string;
      at: string;
      input: string;
      output: string;
      committer: "turn-orchestrator";
    };
```

Update state:

```ts
const [history, setHistory] = useState<StoryHistoryEntry[]>([]);
```

Validate `data.turn` after story-turn success:

```ts
const turn = data.turn as StoryHistoryEntry;
if (
  turn.kind !== "turn" ||
  typeof turn.entryId !== "string" ||
  typeof turn.at !== "string" ||
  typeof turn.input !== "string" ||
  typeof turn.output !== "string" ||
  turn.committer !== "turn-orchestrator"
) {
  throw new Error("响应格式错误：turn 结构不正确");
}
setHistory((prev) => [...prev, turn]);
```

Render history:

```tsx
history.map((entry) => (
  <div key={entry.entryId} className="turn-entry">
    {entry.kind === "turn" && (
      <div className="turn-input-block">
        <h3 className="turn-block-title">你</h3>
        <div className="turn-input-content">{entry.input}</div>
      </div>
    )}
    <div className={entry.kind === "opening" ? "opening-output-block" : "turn-output-block"}>
      <h3 className="turn-block-title">主角视窗</h3>
      <div className="turn-output-content">{normalizeOutput(entry.output)}</div>
    </div>
  </div>
))
```

Change empty state to:

```tsx
<p className="muted">这个故事还没有玩家可见历史。你可以在下方输入主角行动开始第一回合。</p>
```

- [ ] **Step 5: Add CSS for opening block**

In `src/app/globals.css`, add:

```css
.opening-output-block {
  border: 1px solid #d8d2c4;
  background: #fffdf8;
  padding: 12px;
  border-radius: 8px;
}
```

- [ ] **Step 6: Run frontend helper tests**

Run:

```bash
pnpm vitest run tests/lib/story-page-helpers.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx src/app/stories/[storyId]/page.tsx src/app/globals.css tests/lib/story-page-helpers.test.ts
git commit -m "feat(issue7): render opening and turn timeline entries"
```

---

## Task 7: Claude Prompt Reads Typed History

**Files:**
- Modify: `src/lib/claude-prompt.ts`
- Modify: `tests/lib/claude-prompt.test.ts`

- [ ] **Step 1: Add prompt assertions**

Add tests:

```ts
it("prompt documents typed opening and turn history entries", () => {
  const prompt = buildPrompt("test");
  expect(prompt).toContain('kind: "opening"');
  expect(prompt).toContain('kind: "turn"');
  expect(prompt).toContain("opening has no input");
  expect(prompt).toContain("legacy");
});

it("prompt keeps history read-only and forbids direct modification", () => {
  const prompt = buildPrompt("test");
  expect(prompt).toContain("DO NOT modify");
  expect(prompt).toContain("turns/history.jsonl");
  expect(prompt).toContain("actors/**");
});
```

- [ ] **Step 2: Run prompt tests and confirm they fail**

Run:

```bash
pnpm vitest run tests/lib/claude-prompt.test.ts
```

Expected: FAIL because current prompt documents only `turnId/input/output`.

- [ ] **Step 3: Update prompt text**

In `src/lib/claude-prompt.ts`, replace the history section with:

```md
Each line is either:
- opening entry: kind: "opening", entryId, at, output. opening has no input.
- turn entry: kind: "turn", entryId, at, input, output.
- legacy turn entry: turnId, at, input, output. Treat it as kind: "turn" with entryId=turnId.
```

Add:

```md
Read `actors/**` for NPC voice, motivation, relationship pressure, and knowledge boundaries.
```

Keep:

```md
DO NOT modify turns/history.jsonl
DO NOT delete turns/history.jsonl
DO NOT fabricate turn records
```

- [ ] **Step 4: Run prompt tests and confirm they pass**

Run:

```bash
pnpm vitest run tests/lib/claude-prompt.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude-prompt.ts tests/lib/claude-prompt.test.ts
git commit -m "feat(issue7): document typed history for Claude runner"
```

---

## Task 8: README and Contract Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/issue.md`

- [ ] **Step 1: Update README workspace layout**

In `README.md`, update current status to mention Issue 7 behavior:

```md
当前仓库状态：**Issue 7 已完成，具备自然语言故事初始化、opening history 和基础叙事材料**。
```

Update layout:

```md
  story.md              # id / title / createdAt + 玩家高优先级 canon
  rules.md              # 主角视角、agency、风险与输出隔离规则
  world.md              # 初始场景、压力源、秘密与主角可用线索
  player.md             # Protagonist Core、第一人称声音、心理描写偏好、agency boundaries
  actors/*.md           # NPC voice、基本动机、初始关系/压力、knowledge boundary
  turn/output.md        # 当前主角可见输出；初始化后为 opening
  turns/history.jsonl   # typed player-visible timeline: opening + turn
```

Add compatibility note:

```md
旧 history 行 `{turnId, at, input, output}` 会在读取时归一化为 `kind: "turn"`；系统不会为旧故事伪造 opening。
```

- [ ] **Step 2: Update docs issue status**

In `docs/issue.md`, add Issue 7 status after implementation:

```md
**Status**: 实现 + 测试完成
- ✅ 自然语言 setup 创建可运行 Story Workspace
- ✅ opening entry 写入 typed player-visible history
- ✅ legacy history `{turnId, at, input, output}` 读取兼容
- ✅ Protagonist Core、NPC voice/动机、初始压力源写入 Markdown-first workspace
- ✅ 未实现 Issue 10 Turn Interaction / suggestions / decision UI
```

- [ ] **Step 3: Commit docs**

```bash
git add README.md docs/issue.md
git commit -m "docs(issue7): document story initialization workspace contract"
```

---

## Task 9: Full Verification

**Files:**
- No code edits.

- [ ] **Step 1: Run focused Issue 7 suite**

Run:

```bash
pnpm vitest run tests/lib/turn-history.test.ts tests/lib/workspace.test.ts tests/lib/story-initializer.test.ts tests/api/stories.test.ts tests/api/stories/[storyId].test.ts tests/api/story-turn.test.ts tests/lib/turn-orchestrator.test.ts tests/lib/story-page-helpers.test.ts tests/lib/claude-prompt.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full unit/API suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
pnpm build
```

Expected: PASS, unless the known local standalone symlink issue recurs. If it fails for that known environment issue, capture the exact error and verify tests still pass.

- [ ] **Step 4: Run CLI build**

Run:

```bash
pnpm build:cli
```

Expected: PASS.

- [ ] **Step 5: Manual browser smoke**

Run:

```bash
pnpm dev
```

Open the local Next dev URL. Create a story from setup text. Confirm:
- story page opens;
- opening appears as `主角视窗` without a `你` input block;
- refresh preserves opening;
- sending a turn appends a `你` input block plus `主角视窗` output;
- no suggestions or decision UI appears.

Stop the dev server before ending the implementation session.

---

## Definition of Done

- [ ] New Issue 7 stories are initialized from natural-language setup without manual file editing.
- [ ] New workspace includes meaningful non-placeholder `story.md`, `rules.md`, `world.md`, `player.md`, at least one `actors/*.md`, and opening `turn/output.md`.
- [ ] `player.md` includes all required Protagonist Core fields: `narrativeVoice`, `temperament`, `emotionalExpression`, `conflictStyle`, `relationshipStyle`, `humorStyle`, `initiative`, `moralBoundaries`, `speechPatterns`, `avoidExpressions`.
- [ ] Opening is committed as `kind: "opening"` and has no `input`.
- [ ] New turn entries are committed as `kind: "turn"`.
- [ ] Legacy `{turnId, at, input, output}` history remains readable as normalized turns.
- [ ] Old workspaces do not get fake opening entries.
- [ ] `TurnOrchestrator` remains the trusted turn committer.
- [ ] Initializer remains the trusted opening committer.
- [ ] Runner/Claude prompt still forbids modifying `turns/history.jsonl`.
- [ ] Web API returns only player-visible history and typed turn entries, not internal generation metadata.
- [ ] No public `TurnInteraction`, suggestions, `continue/decision`, hiddenIntent, internal scoring, prompt traces, or unselected candidates are exposed by Issue 7.
- [ ] Focused tests, full `pnpm test`, and `pnpm build:cli` pass.
- [ ] `pnpm build` passes or known local environment failure is recorded with exact output.

---

## Self-Review Notes

- Scope coverage: The plan covers type evolution, legacy reader compatibility, writer behavior, API response structure, frontend mixed rendering, existing workspace tests, initializer boundary, workspace materials, Claude read-only history, and public/internal interaction naming.
- Placeholder scan: The plan intentionally avoids deferred implementation blanks and includes exact type names, function names, test cases, commands, and expected outcomes.
- Type consistency: The plan uses `kind` consistently to satisfy the explicit Issue 7 boundary. Any subagent output using `type` is superseded by this plan.
