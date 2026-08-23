import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyInitWorkspaceBundle, parseInitWorkspaceBundle } from "@/lib/init-bundle";

const VALID_BUNDLE = [
  "=== FILE: world.md ===",
  "# 世界设定\n\n一座被雨包围的灯塔。",
  "=== FILE: player.md ===",
  "# 主角\n\n## Protagonist Core\n声音克制。",
  "=== FILE: rules.md ===",
  "# 规则\n\n风险由随机工具判定。",
  "=== FILE: actors/keeper.md ===",
  "# 守塔人\n\n## 表面形象\n穿旧雨衣，手上有灯油味。\n\n## voice\n短句，少解释。\n\n## Emotional Core\ncoreNeed: 被需要。\n\n## Relationship State: 主角\nsurfaceRelationship: 新来的学徒。\n\n## Emotionally Salient Memories\n（初始暂无。）\n\n## Current Intent\ncurrentEmotion: 警觉。",
].join("\n");

describe("Init Workspace Bundle", () => {
  it("parses and atomically applies a complete bundle", async () => {
    const parsed = parseInitWorkspaceBundle(VALID_BUNDLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "init-bundle-"));
    await fs.mkdir(path.join(dir, "actors"), { recursive: true });
    await fs.writeFile(path.join(dir, "world.md"), "旧世界\n");

    await applyInitWorkspaceBundle(dir, parsed.files);

    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("被雨包围");
    await expect(fs.readFile(path.join(dir, "player.md"), "utf8")).resolves.toContain("Protagonist Core");
    await expect(fs.readFile(path.join(dir, "actors/keeper.md"), "utf8")).resolves.toContain("Emotional Core");
  });

  it("rejects an invalid bundle before applying any file", async () => {
    const invalid = VALID_BUNDLE.replace("=== FILE: actors/keeper.md ===", "=== FILE: story.md ===");
    const parsed = parseInitWorkspaceBundle(invalid);
    expect(parsed.ok).toBe(false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "init-bundle-"));
    await fs.writeFile(path.join(dir, "world.md"), "原始世界\n");
    await expect(applyInitWorkspaceBundle(dir, invalid)).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toBe("原始世界\n");
  });

  it("allows canon text that mentions TODO or placeholder words", () => {
    const legalCanon = VALID_BUNDLE.replace(
      "## Emotional Core\ncoreNeed: 被需要。",
      "## Emotional Core\ncoreNeed: 被需要。\n备注：TODO 和 placeholder 是故事设定中的原文。",
    );
    expect(parseInitWorkspaceBundle(legalCanon).ok).toBe(true);
  });

  it.each([
    "TODO: later",
    "占位：待补充",
    "# TBD",
  ])("rejects a standalone scaffold marker: %s", (marker) => {
    const marked = VALID_BUNDLE.replace("一座被雨包围的灯塔。", marker);
    expect(parseInitWorkspaceBundle(marked).ok).toBe(false);
  });

  it.each([
    "=== FILE: world.md ===\n\n=== FILE: player.md ===\n内容\n=== FILE: rules.md ===\n内容\n=== FILE: actors/a.md ===\n内容",
    "=== FILE: world.md ===\n内容\n=== FILE: world.md ===\n重复\n=== FILE: player.md ===\n内容\n=== FILE: rules.md ===\n内容\n=== FILE: actors/a.md ===\n内容",
    "=== FILE: world.md ===\n内容\n=== FILE: player.md ===\n内容\n=== FILE: rules.md ===\n内容\n=== FILE: actors/nested/a.md ===\n内容",
    "=== FILE: world.md ===\n内容\n=== FILE: player.md ===\n内容\n=== FILE: rules.md ===\n内容\n=== FILE: ../outside.md ===\n内容",
    "=== FILE: world.md ===\n内容\n=== FILE: player.md ===\n内容\n=== FILE: rules.md ===\n内容\n=== FILE: /etc/passwd ===\n内容",
    "=== FILE: world.md ===\n内容\n=== FILE: player.md ===\n内容\n=== FILE: rules.md ===\n内容\n=== FILE: actors\\evil.md ===\n内容",
    "=== FILE: world.md ===\n内容\n=== FILE: player.md ===\n内容\n=== FILE: rules.md ===\n内容\n=== FILE: turn/input.md ===\n内容",
    "=== FILE: world.md ===\n内容\n=== FILE: player.md ===\n内容\n=== FILE: rules.md ===\n内容\n=== FILE: actors/a.md ===\n（占位）",
  ])("rejects malformed or out-of-scope file sections: %s", (bundle) => {
    expect(parseInitWorkspaceBundle(bundle).ok).toBe(false);
  });

  it("rejects an actor bundle that omits the Emotionally Salient Memories heading", () => {
    const missingHeading = VALID_BUNDLE.replace("## Emotionally Salient Memories", "## 私有记忆");
    expect(parseInitWorkspaceBundle(missingHeading).ok).toBe(false);
  });

  it("requires event, meaning, and impact when initial memories are present", () => {
    const incompleteMemory = VALID_BUNDLE.replace(
      "（初始暂无。）",
      "- event: 旧事故\n- meaning: 他仍未释怀。",
    );
    expect(parseInitWorkspaceBundle(incompleteMemory).ok).toBe(false);
  });
});
