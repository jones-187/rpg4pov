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

    const raw = await fs.readFile(path.join(workspaceDir, "logs", RANDOM_ROLLS_LOG), "utf8");
    const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(entry.rollId).toBe("workspace-dir-check");
    expect(entry.selectedId).toBe("fail");
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

  it("uses crypto randomness when rng is omitted", async () => {
    const meta = await createStory({ title: "crypto random source" });
    const result = await rollChoice({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      rollId: "crypto-smoke",
      candidates: [{ id: "only", label: "唯一结果", weight: 1 }],
    });

    expect(result.randomSource).toBe("crypto");
    expect(result.selectedId).toBe("only");
    expect(Number.isFinite(result.sample)).toBe(true);
    expect(result.sample).toBeGreaterThanOrEqual(0);
    expect(result.sample).toBeLessThan(1);
    const logs = await readRandomLogs(meta.storyId);
    expect(logs[0]).toMatchObject({
      rollId: "crypto-smoke",
      selectedId: "only",
      randomSource: "crypto",
      sample: result.sample,
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

  it.each([
    {
      name: "empty candidates",
      candidates: [] as RollChoiceCandidate[],
      message: "candidates",
    },
    {
      name: "duplicate id",
      candidates: [
        { id: "same", weight: 1 },
        { id: "same", weight: 2 },
      ],
      message: "duplicate",
    },
    {
      name: "blank id",
      candidates: [{ id: " ", weight: 1 }],
      message: "candidate id",
    },
    {
      name: "zero weight",
      candidates: [{ id: "zero", weight: 0 }],
      message: "weight",
    },
    {
      name: "negative weight",
      candidates: [{ id: "negative", weight: -1 }],
      message: "weight",
    },
    {
      name: "NaN weight",
      candidates: [{ id: "nan", weight: Number.NaN }],
      message: "weight",
    },
    {
      name: "Infinity weight",
      candidates: [{ id: "infinity", weight: Number.POSITIVE_INFINITY }],
      message: "weight",
    },
    {
      name: "non-finite totalWeight",
      candidates: [
        { id: "huge-a", weight: Number.MAX_VALUE },
        { id: "huge-b", weight: Number.MAX_VALUE },
      ],
      message: "totalWeight",
    },
  ])("rejects invalid candidates: $name", async ({ candidates, message }) => {
    const meta = await createStory();
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    await expect(
      rollChoice({
        storyId: meta.storyId,
        workspaceDir,
        rollId: "invalid-candidates",
        candidates,
        rng: fixedRng(0.1),
      }),
    ).rejects.toThrow(message);
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
