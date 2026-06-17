import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";
import { RANDOM_ROLLS_LOG } from "@/lib/random-tool";

// 设计决策：本测试直接导入库函数 rollChoice 进行验证，而非通过 CLI 端到端运行。
// 原因：wrapper 仅是 stdin/stdout 外壳，真正的 CLI 端到端验证推迟到 HITL
// （在类生产镜像中执行 `node /app/cli/roll-choice.js`）。
// 本测试作为契约锚点，验证 wrapper 所复用的库函数行为。
beforeAll(async () => {
  await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("roll-choice CLI wrapper 契约（经库函数验证）", () => {
  it("库函数接受输入并返回 RollChoiceResult（wrapper 复用同一逻辑）", async () => {
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

  it("非法输入（空 candidates）库函数应抛错（wrapper 捕获后 exit 1）", async () => {
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
