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
