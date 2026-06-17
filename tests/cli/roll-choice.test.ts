import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStory, resolveWorkspaceDir, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";
import { RANDOM_ROLLS_LOG } from "@/lib/random-tool";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("roll-choice CLI wrapper 契约（经库函数验证）", () => {
  it("接受 stdin JSON {storyId,workspaceDir,rollId,candidates} 返回 stdout JSON RollChoiceResult", async () => {
    const meta = await createStory({ title: "cli wrapper 测试" });
    const input = {
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      rollId: "lockpick",
      candidates: [
        { id: "success", weight: 1 },
        { id: "fail", weight: 1 },
      ],
    };
    const { rollChoice } = await import("@/lib/random-tool");
    const result = await rollChoice({ ...input, rng: () => 0.0 });
    expect(result.selectedId).toBe("success");
    expect(result.rollId).toBe("lockpick");
    expect(result.randomSource).toBe("injected");
    const logs = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", RANDOM_ROLLS_LOG),
      "utf8",
    );
    expect(logs).toContain("lockpick");
    expect(logs).toContain("success");
  });

  it("非法输入（缺 candidates）应非零退出（wrapper 行为）", async () => {
    const { rollChoice } = await import("@/lib/random-tool");
    await expect(
      rollChoice({
        storyId: "00000000-0000-0000-0000-000000000000",
        workspaceDir: "/tmp",
        rollId: "test",
        candidates: [],
      }),
    ).rejects.toThrow();
  });
});
