import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  INIT_SKELETON_FILES,
  readInitOpeningContext,
  readInitSkeletonContext,
} from "@/lib/init-context";
import { parsePublicScene, parsePublicSceneFromPlayer } from "@/lib/public-scene";
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

  it("parses the only public scene section and returns JSON without private files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "init-context-"));
    await fs.mkdir(path.join(dir, "actors"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "player.md"),
      [
        "# 主角",
        "",
        "## Public Scene",
        JSON.stringify({
          time: "清晨",
          location: "渡口",
          narrativeVoice: "第一人称，克制。",
          knownFacts: ["渡船今晚停航"],
          visibleActors: [{ name: "守塔人", appearance: "穿旧雨衣", voice: "短句，少解释" }],
        }),
        "",
        "## 初始状态",
        "不知道：三年前失事。",
        "## 私有设定",
        "不应进入开场上下文。",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(dir, "actors", "keeper.md"),
      [
        "# 守塔人",
        "",
        "## 表面形象",
        "穿旧雨衣。",
        "## voice",
        "短句，少解释。",
        "## Current Intent",
        "hiddenIntent: 不应进入开场上下文。",
      ].join("\n"),
    );

    const context = await readInitOpeningContext(dir);

    expect(JSON.parse(context)).toEqual({
      time: "清晨",
      location: "渡口",
      narrativeVoice: "第一人称，克制。",
      knownFacts: ["渡船今晚停航"],
      visibleActors: [{ name: "守塔人", appearance: "穿旧雨衣", voice: "短句，少解释" }],
    });
    expect(context).not.toContain("不应进入开场上下文");
    expect(context).not.toContain("三年前失事");
    expect(context).not.toContain("hiddenIntent");
  });

  it("accepts one json fenced public scene and rejects duplicate or malformed sections", () => {
    const scene = {
      time: "清晨",
      location: "渡口",
      narrativeVoice: "第一人称，克制。",
      knownFacts: [],
      visibleActors: [],
    };
    const player = ["# 主角", "", "## Public Scene", "```json", JSON.stringify(scene), "```"].join("\n");

    expect(parsePublicSceneFromPlayer(player)).toEqual(scene);
    expect(parsePublicScene(scene)).toEqual(scene);
    expect(() => parsePublicSceneFromPlayer(`${player}\n\n## Public Scene\n${JSON.stringify(scene)}`)).toThrow();
    expect(() => parsePublicSceneFromPlayer(player.replace("```json", "```text"))).toThrow();
    expect(() => parsePublicSceneFromPlayer(player.replace(JSON.stringify(scene), `${JSON.stringify(scene)}\n说明`))).toThrow();
  });

  it.each([
    "",
    "# 主角\n\n## Protagonist Core\n秘密",
    "# 主角\n\n## Public Scene\n{}",
    `# 主角\n\n## Public Scene\n${JSON.stringify({
      time: "清晨",
      location: "渡口",
      narrativeVoice: "第一人称",
      knownFacts: [""],
      visibleActors: [],
    })}`,
    `# 主角\n\n## Public Scene\n${JSON.stringify({
      time: "清晨",
      location: "渡口",
      narrativeVoice: "第一人称",
      knownFacts: [],
      visibleActors: [],
      secret: "未知",
    })}`,
    `# 主角\n\n## Public Scene\n${JSON.stringify({
      time: "x".repeat(2_001),
      location: "渡口",
      narrativeVoice: "第一人称",
      knownFacts: [],
      visibleActors: [],
    })}`,
    `# 主角\n\n## Public Scene\n${JSON.stringify({
      time: "清晨",
      location: "渡口",
      narrativeVoice: "第一人称",
      knownFacts: Array.from({ length: 21 }, (_, index) => `事实${index}`),
      visibleActors: [],
    })}`,
  ])("rejects missing or invalid public scene data", (player) => {
    expect(() => parsePublicSceneFromPlayer(player)).toThrow();
  });

  it("throws when player.md is missing instead of falling back to actor or state files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "init-context-"));
    await fs.mkdir(path.join(dir, "actors"), { recursive: true });
    await fs.writeFile(path.join(dir, "world.md"), "秘密真相：三年前失事");
    await fs.writeFile(path.join(dir, "actors", "keeper.md"), "## voice\n私有声音");

    await expect(readInitOpeningContext(dir)).rejects.toThrow();
  });
});
