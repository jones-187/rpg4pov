import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  INIT_SKELETON_FILES,
  readInitSkeletonContext,
} from "@/lib/init-context";
import { INIT_SKELETON_FILES as CLAUDE_SKELETON_FILES } from "@/lib/claude-prompt";

describe("shared initialization context", () => {
  it("keeps the shared skeleton list stable for both init runners", () => {
    expect(CLAUDE_SKELETON_FILES).toEqual(INIT_SKELETON_FILES);
    expect(INIT_SKELETON_FILES).toEqual(["story.md", "world.md", "player.md", "rules.md"]);
  });

  it("keeps complete contents and missing-file semantics in one reader", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "init-context-"));
    await fs.writeFile(path.join(dir, "story.md"), "story skeleton\n");
    await fs.writeFile(path.join(dir, "world.md"), "world skeleton\n");

    const context = await readInitSkeletonContext(dir);

    expect(context).toContain("=== story.md ===\nstory skeleton");
    expect(context).toContain("=== world.md ===\nworld skeleton");
    expect(context).toContain("=== player.md ===\n（不存在）");
    expect(context).toContain("=== rules.md ===\n（不存在）");
  });
});
