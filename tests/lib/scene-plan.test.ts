import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildSceneRenderContext, parseScenePlan } from "@/lib/scene-plan";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

beforeEach(() => useTempWorkspaceRoot());
afterEach(() => resetWorkspaceRoot());

const PUBLIC_SCENE = {
  time: "清晨",
  location: "渡口",
  narrativeVoice: "第一人称克制",
  knownFacts: ["渡船今晚停航"],
  visibleActors: [{ name: "林", appearance: "旧雨衣", voice: "短句" }],
};

function validPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "scene",
    publicScene: PUBLIC_SCENE,
    visibleEvents: ["她把手从灶台边收回，说今晚走不了。"],
    stateUpdate: "=== FILE: world.md ===\nAPPEND: 她销毁了证据",
    interaction: { mode: "decision", suggestions: ["问清停航原因"] },
    ...overrides,
  };
}

describe("experimental visible scene contract", () => {
  it("renders only the plan's public scene and visible events, never workspace or state-update secrets", async () => {
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    await fs.writeFile(path.join(dir, "world.md"), "秘密真相：船票被她烧掉");
    await fs.writeFile(
      path.join(dir, "player.md"),
      [
        "# 主角",
        "## Public Scene",
        JSON.stringify({
          time: "昨天",
          location: "旧地点",
          narrativeVoice: "旧声音",
          knownFacts: ["旧事实"],
          visibleActors: [{ name: "旧人物", appearance: "旧外貌", voice: "旧口吻" }],
        }),
      ].join("\n"),
    );
    await fs.mkdir(path.join(dir, "actors"), { recursive: true });
    await fs.writeFile(path.join(dir, "actors/a.md"), "私有演员卡：隐瞒烧票");

    const plan = parseScenePlan(JSON.stringify(validPlan()));
    const context = await buildSceneRenderContext(dir, plan);

    expect(context).toContain("清晨");
    expect(context).toContain("渡船今晚停航");
    expect(context).toContain("旧雨衣");
    expect(context).toContain("她把手从灶台边收回");
    for (const secret of [
      "昨天",
      "旧地点",
      "旧声音",
      "旧事实",
      "秘密真相",
      "烧票",
      "销毁了证据",
      "stateUpdate",
    ]) expect(context).not.toContain(secret);
  });

  it.each([
    {},
    { kind: "scene" },
    { kind: "scene", publicScene: { ...PUBLIC_SCENE, location: "" } },
    { kind: "scene", publicScene: { ...PUBLIC_SCENE, unknown: "不允许" } },
    { kind: "scene", publicScene: { ...PUBLIC_SCENE, visibleActors: [{ name: "林", appearance: "旧雨衣" }] } },
    { kind: "scene", publicScene: { ...PUBLIC_SCENE, knownFacts: [""] } },
    { ...validPlan(), kind: "turn" },
    { ...validPlan(), visibleEvents: [] },
    { ...validPlan(), stateUpdate: "" },
    { ...validPlan(), interaction: {} },
  ])("rejects incomplete or invalid plans", (plan) => {
    expect(() => parseScenePlan(JSON.stringify(plan))).toThrow();
  });
});
